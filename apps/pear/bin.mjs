// Modified from hello-pear-qvac-tui/bin.mjs (Apache-2.0).

import os from 'bare-os';
import path from 'bare-path';
import process from 'bare-process';
import { persistent } from 'bare-storage';
import { Program } from 'bare-tui';
import { command, flag, summary } from 'paparam';
import { isWindows } from 'which-runtime';
import App from './app.js';
import Daemon from './lib/daemon.js';
import Inference from './lib/inference.js';
import Narrator from './lib/narrator.js';
import prompt from './lib/prompt.js';
import pkg from './package.json';
import uiModule from './ui/app.js';

const { App: UI } = uiModule;
const { buildExplanationRequest } = prompt;
const appName = 'agentigram-pear';
const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare');
const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'print the current version'),
  flag('--root <dir>', 'joined Agentigram repository (default current directory)'),
  flag('--socket <path>', 'explicit local Unix socket or Windows named pipe'),
  flag('--room <id>', 'room id required with --socket'),
  flag('--storage <dir>', 'custom Pear storage directory'),
  flag('--model <name>', 'QVAC model constant'),
  flag('--ctx <tokens>', 'model context window'),
  flag('--no-updates', 'disable Pear OTA updates'),
  flag('--verbose', 'log QVAC engine detail to stderr'),
);

// pnpm forwards its conventional argument separator to nested workspace scripts.
// Paparam treats a literal `--` as the end of options, so remove only that marker.
cmd.parse(Bare.argv.slice(isDev ? 2 : 1).filter((argument) => argument !== '--'));
if (cmd.flags.help) Bare.exit();
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`);
  Bare.exit();
}

const invocationDirectory = process.env.INIT_CWD || '.';
const root = path.resolve(invocationDirectory, cmd.flags.root || '.');
const model = cmd.flags.model || pkg.qvac.model;
const ctxSize = Number(cmd.flags.ctx) || pkg.qvac.ctxSize;
const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName));
const dir = storage || path.join(os.tmpdir(), 'pear', appName);
const configured = !pkg.upgrade.includes('<');
const updating = cmd.flags.updates !== false && configured;

const updater = updating
  ? new App({
      dir,
      app: isDev ? null : os.execPath(),
      updates: true,
      version: pkg.version,
      upgrade: pkg.upgrade,
      name: isWindows ? `${appName}.exe` : appName,
    })
  : null;
const inference = new Inference({ model, ctxSize, verbose: cmd.flags.verbose === true });
const daemon = new Daemon({ root, socket: cmd.flags.socket, room: cmd.flags.room });
const narrator = new Narrator(inference);

let program;
const ui = new UI({
  model,
  version: pkg.version,
  onCancel: () => narrator.cancel(),
  onApplyUpdate: () => {
    updater
      ?.applyUpdate()
      .then(() => program.send({ type: 'update.applied' }))
      .catch((error) => program.send({ type: 'update.error', message: error.message }));
  },
});
program = new Program(ui, { mouse: true });

let modelReady = false;
let modelFailed = false;
let pending = [];

function failModel(message) {
  if (modelFailed) return;

  modelFailed = true;
  program.send({ type: 'qvac.error', message });

  const queued = pending;
  pending = [];
  explain(queued);
}

function explain(events) {
  if (events.length === 0) return;
  if (modelFailed) {
    const request = buildExplanationRequest(events);
    if (request) {
      program.send({
        type: 'explanation.complete',
        id: -events.at(-1).seq,
        text: request.fallback,
        fallback: true,
      });
    }
    return;
  }
  if (!modelReady) {
    pending = [...pending, ...events].slice(-8);
    return;
  }
  const { started, superseded } = narrator.start(events);
  if (superseded) program.send({ type: 'explanation.complete', ...superseded });
  if (started) program.send({ type: 'explanation.started', ...started });
}

daemon.on('snapshot', (snapshot) => {
  program.send({ type: 'daemon.snapshot', snapshot });
  explain(snapshot.events);
});
daemon.on('daemon-error', (message) => program.send({ type: 'daemon.error', message }));
daemon.on('error', (error) => program.send({ type: 'daemon.error', message: error.message }));

inference.on('progress', (percentage) => program.send({ type: 'qvac.progress', percentage }));
inference.on('loaded', (loadedModel, loadedCtx) => {
  modelReady = true;
  program.renderer.clear();
  program.send({ type: 'qvac.loaded', model: loadedModel, ctxSize: loadedCtx });
  const queued = pending;
  pending = [];
  explain(queued);
});
inference.on('delta', (id, text) => {
  const delta = narrator.delta(id, text);
  if (delta) program.send({ type: 'explanation.delta', ...delta });
});
inference.on('end', (id) => {
  const completed = narrator.finish(id);
  if (completed) program.send({ type: 'explanation.complete', ...completed });
});
inference.on('answer-error', (id, message) => {
  if (id === undefined) {
    failModel(message);
  } else {
    const completed = narrator.fail(id);
    if (completed) program.send({ type: 'explanation.complete', ...completed });
  }
});
inference.on('error', (error) => {
  failModel(error.message);
});

if (updater) {
  updater.on('updated', () => program.send({ type: 'update.ready' }));
  updater.on('error', (error) => program.send({ type: 'update.error', message: error.message }));
}

function teardown() {
  narrator.cancel('shutdown');
  return Promise.allSettled([inference.close(), daemon.close(), updater?.close()]);
}

async function shutdown(code = 0) {
  Bare.exitCode = code;
  program.quit();
  await teardown();
}

process.on('SIGHUP', () => shutdown(129));
process.on('SIGINT', () => shutdown(130));
process.on('SIGQUIT', () => shutdown(131));
process.on('SIGTERM', () => shutdown(143));

try {
  inference.ready().catch((error) => {
    failModel(error.message);
  });
  daemon.ready().catch((error) => program.send({ type: 'daemon.error', message: error.message }));
  updater?.ready().catch((error) => program.send({ type: 'update.error', message: error.message }));
  await program.run();
} finally {
  await teardown();
}
