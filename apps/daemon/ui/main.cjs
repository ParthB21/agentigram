'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { createConnection } = require('node:net');
const { homedir } = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const STATUS_INTERVAL_MS = 1_000;
const IPC_TIMEOUT_MS = 1_000;
const root = path.resolve(process.env.AGENTIGRAM_ROOT || process.cwd());
let voiceSettings = { enabled: true, volume: 0.8 };
let statusTimer;

function statePath() {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(homedir(), '.agentigram', 'installations', `${key}.json`);
}

function installState() {
  const file = statePath();
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
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

function createWindow() {
  const window = new BrowserWindow({
    width: 780,
    height: 500,
    minWidth: 620,
    minHeight: 420,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    roundedCorners: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('agentigram:get-status', (event) =>
  trusted(event) ? status() : Promise.reject(new Error('untrusted renderer')),
);
ipcMain.handle('agentigram:human-action', (event, action) =>
  trusted(event)
    ? requestDaemon({ type: 'human', action })
    : Promise.reject(new Error('untrusted renderer')),
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
  statusTimer = setInterval(async () => {
    const next = await status();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agentigram:status', next);
    }
  }, STATUS_INTERVAL_MS);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => clearInterval(statusTimer));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
