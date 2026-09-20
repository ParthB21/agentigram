'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { createConnection } = require('node:net');
const { homedir } = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const STATUS_INTERVAL_MS = 1_000;
const IPC_TIMEOUT_MS = 1_000;
const RESUBSCRIBE_MS = 1_000;
let root = path.resolve(process.env.AGENTIGRAM_ROOT || process.cwd());
let voiceSettings = { enabled: true, volume: 0.8 };
let statusTimer;
let stream = null;
let resubscribeTimer = null;

function statePath() {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(homedir(), '.agentigram', 'installations', `${key}.json`);
}

function installState() {
  const file = statePath();
  if (existsSync(file)) return readState(file);

  // A packaged app is normally launched from the Start menu or Finder rather
  // than a repository. In that case, attach to the most recently configured
  // Agentigram workspace instead of treating the application directory as a
  // project root. `agg ui` still supplies an explicit root and takes priority.
  if (process.env.AGENTIGRAM_ROOT) return undefined;
  const directory = path.join(homedir(), '.agentigram', 'installations');
  if (!existsSync(directory)) return undefined;
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(directory, name))
    .map((file) => {
      try {
        return { file, modified: statSync(file).mtimeMs };
      } catch {
        return { file, modified: 0 };
      }
    })
    .sort((left, right) => right.modified - left.modified)
    .map(({ file }) => file);
  for (const candidate of candidates) {
    const state = readState(candidate);
    if (!state?.root || !state?.socketPath) continue;
    root = path.resolve(state.root);
    return state;
  }
  return undefined;
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : undefined;
  } catch {
    return undefined;
  }
}

function requestDaemon(request) {
  const state = installState();
  if (!state) return Promise.resolve({ ok: false, error: 'Agentigram is not configured here' });
  return new Promise((resolve) => {
    const socket = createConnection(state.socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'Local daemon did not respond' });
    }, IPC_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(data.slice(0, newline)));
      } catch {
        resolve({ ok: false, error: 'Local daemon returned invalid data' });
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

function trusted(event) {
  return event.senderFrame.url.startsWith('file:');
}

async function status() {
  const response = await requestDaemon({ type: 'status' });
  return response.ok ? response.output : { transport: 'closed', error: response.error };
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

/**
 * One long-lived subscription to the daemon, forwarded to the renderer.
 *
 * Polling `status` shows the room as it stands but never the events that got it
 * there, and the event feed is most of what makes the window worth watching.
 * The daemon drops a subscriber when its socket closes, so reconnecting is the
 * whole recovery story: a fresh subscribe replays current state.
 */
function subscribe() {
  const state = installState();
  if (!state) return;

  let socket;
  try {
    socket = createConnection(state.socketPath);
  } catch {
    scheduleResubscribe();
    return;
  }
  stream = socket;

  let buffer = '';
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'subscribe' })}\n`));
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          const frame = JSON.parse(line);
          if (isRoomFrame(frame)) broadcast('agentigram:frame', frame);
        } catch {
          // A malformed frame is not worth taking the window down for.
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => scheduleResubscribe());
  socket.on('close', () => scheduleResubscribe());
}

/** Validate the local socket boundary before data reaches the sandboxed renderer. */
function isRoomFrame(frame) {
  if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return false;
  if (frame.t === 'state') return Boolean(frame.state && typeof frame.state === 'object');
  if (frame.t === 'wake') {
    return typeof frame.sessionId === 'string' && Number.isInteger(frame.seq);
  }
  if (frame.t !== 'event') return false;
  if (
    !Number.isInteger(frame.seq) ||
    typeof frame.eventType !== 'string' ||
    typeof frame.text !== 'string'
  ) {
    return false;
  }
  if (frame.sessionId !== undefined && typeof frame.sessionId !== 'string') return false;
  if (frame.speech === undefined) return true;
  return (
    frame.speech &&
    typeof frame.speech === 'object' &&
    typeof frame.speech.speaker === 'string' &&
    typeof frame.speech.text === 'string' &&
    Number.isInteger(frame.speech.priority) &&
    frame.speech.priority >= 0 &&
    frame.speech.priority <= 3
  );
}

function scheduleResubscribe() {
  if (resubscribeTimer) return;
  stream = null;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    subscribe();
  }, RESUBSCRIBE_MS);
}

function createWindow() {
  // Vibrancy, the inset traffic lights and a transparent background are macOS
  // features. On Windows a transparent frameless window loses its close button
  // and paints badly, so everything there stays a normal opaque window.
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const window = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 720,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: isMac || isWindows ? '#00000000' : '#07090F',
    ...(isMac
      ? {
          transparent: true,
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 18, y: 18 },
          vibrancy: 'under-window',
          visualEffectState: 'active',
        }
      : isWindows
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
              color: '#00000000',
              symbolColor: '#DDE4F4',
              height: 64,
            },
          }
        : {}),
    roundedCorners: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (isWindows && typeof window.setBackgroundMaterial === 'function') {
    try {
      window.setBackgroundMaterial('mica');
    } catch {
      // Windows versions without DWM backdrop support keep the CSS material.
    }
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('agentigram:get-status', (event) =>
  trusted(event) ? status() : Promise.reject(new Error('untrusted renderer')),
);
ipcMain.handle('agentigram:set-voice', (event, settings) => {
  if (!trusted(event)) throw new Error('untrusted renderer');
  if (
    !settings ||
    typeof settings.enabled !== 'boolean' ||
    typeof settings.volume !== 'number' ||
    settings.volume < 0 ||
    settings.volume > 1
  ) {
    throw new Error('invalid voice settings');
  }
  voiceSettings = { enabled: settings.enabled, volume: settings.volume };
  return voiceSettings;
});
ipcMain.handle('agentigram:open-dashboard', async (event) => {
  if (!trusted(event)) throw new Error('untrusted renderer');
  await shell.openExternal('http://localhost:3000');
});

app.whenReady().then(() => {
  createWindow();
  subscribe();
  // The stream carries state on connect and after every batch. This poll is the
  // backstop that keeps the window honest when the daemon is down entirely —
  // the stream cannot report that, because it is not connected to say so.
  statusTimer = setInterval(async () => {
    if (stream) return;
    broadcast('agentigram:status', await status());
  }, STATUS_INTERVAL_MS);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  clearInterval(statusTimer);
  clearTimeout(resubscribeTimer);
  stream?.destroy();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
