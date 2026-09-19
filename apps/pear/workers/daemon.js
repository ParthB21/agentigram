'use strict';

// A local-only adapter. It connects to the daemon's Unix socket on macOS/Linux
// or named pipe on Windows; it never listens and never exposes daemon IPC remotely.
const FramedStream = require('framed-stream');
const fs = require('bare-fs');
const net = require('bare-net');
const os = require('bare-os');
const path = require('bare-path');
const { isBareKit } = require('which-runtime');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)];
const root = path.resolve(argv(0) || '.');
const socketOverride = argv(1) || '';
const roomOverride = argv(2) || '';
const pollMs = Math.max(250, Number(argv(3)) || 750);
const pipe = new FramedStream(Bare.IPC);
const send = (message) => pipe.write(JSON.stringify(message));

let cursor = 0;
let timer = null;
let activeSocket = null;
let closing = false;
let lastError = '';

function installation() {
  if (socketOverride) {
    if (!roomOverride) throw new Error('--room is required with --socket');
    return { root, roomId: roomOverride, socketPath: socketOverride };
  }
  const directory = path.join(os.homedir(), '.agentigram', 'installations');
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (samePath(state.root, root) && validEndpoint(state.socketPath) && state.roomId)
        return state;
    } catch {}
  }
  throw new Error(`Agentigram is not joined in ${root}`);
}

function request(state) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(state.socketPath);
    activeSocket = socket;
    let raw = '';
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeSocket === socket) activeSocket = null;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => done(new Error('daemon IPC timed out')), 1500);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'presentation', afterSeq: cursor })}\n`);
    });
    socket.once('error', (error) => done(error));
    socket.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_RESPONSE_BYTES) return done(new Error('daemon response too large'));
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(raw.slice(0, newline));
        if (response.ok !== true) throw new Error(response.error || 'daemon rejected request');
        done(null, validateSnapshot(response.output, state.roomId));
      } catch (error) {
        done(error);
      }
    });
  });
}

async function poll() {
  if (closing) return;
  try {
    const state = installation();
    const snapshot = await request(state);
    cursor = Math.max(cursor, snapshot.headSeq);
    lastError = '';
    send({ t: 'snapshot', snapshot });
  } catch (error) {
    const message = String(error?.message || error);
    if (message !== lastError) {
      lastError = message;
      send({ t: 'error', message });
    }
  }
  if (!closing) timer = setTimeout(poll, pollMs);
}

function validateSnapshot(value, expectedRoom) {
  if (!value || typeof value !== 'object') throw new Error('invalid daemon presentation response');
  if (value.roomId !== expectedRoom) throw new Error('daemon returned the wrong room');
  if (!['connecting', 'connected', 'read-only', 'closed'].includes(value.transport)) {
    throw new Error('daemon returned an invalid transport state');
  }
  if (!Number.isInteger(value.headSeq) || value.headSeq < 0 || !Array.isArray(value.events)) {
    throw new Error('daemon returned an invalid presentation cursor');
  }
  const events = value.events.map(validateEvent);
  return { roomId: value.roomId, transport: value.transport, headSeq: value.headSeq, events };
}

function validateEvent(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid presentation event');
  if (!Number.isInteger(value.seq) || value.seq < 0) throw new Error('invalid event sequence');
  if (!Array.isArray(value.sourceSeqs) || value.sourceSeqs.some((seq) => !Number.isInteger(seq))) {
    throw new Error('invalid event source sequences');
  }
  if (typeof value.type !== 'string' || typeof value.actor !== 'string') {
    throw new Error('invalid presentation event identity');
  }
  if (!value.facts || typeof value.facts !== 'object' || typeof value.fallback !== 'string') {
    throw new Error('invalid presentation event facts');
  }
  return value;
}

function validEndpoint(value) {
  return typeof value === 'string' && value.length > 0;
}

function samePath(left, right) {
  const normal = (value) => path.resolve(String(value)).replaceAll('\\', '/').toLowerCase();
  return normal(left) === normal(right);
}

pipe.on('data', (data) => {
  try {
    const message = JSON.parse(data.toString());
    if (message.t !== 'close') return;
    closing = true;
    clearTimeout(timer);
    activeSocket?.destroy();
    send({ t: 'closed' });
  } catch {}
});

poll();
