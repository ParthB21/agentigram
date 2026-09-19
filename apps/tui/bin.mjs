import { command, flag, summary } from 'paparam'
import { persistent } from 'bare-storage'
import { Program } from 'bare-tui'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import pkg from './package.json'
import Inference from './lib/inference.js'
import Room from './lib/room.js'
import { App as UI } from './ui/app.js'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--socket <path>', 'Agentigram daemon socket (default: $AGENTIGRAM_SOCKET)'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--model <name>', 'QVAC model constant to load'),
  flag('--ctx <tokens>', 'context window in tokens (default 8192)'),
  flag('--verbose', 'log engine and native addon detail to stderr')
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))
if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

// The daemon owns the room; this process only views and negotiates. `agentigram
// tui` passes the socket explicitly, and the hook installer exports the same
// path as AGENTIGRAM_SOCKET, so a bare run inside a joined repo needs no flag.
const socket = cmd.flags.socket || process.env.AGENTIGRAM_SOCKET
if (!socket) {
  console.error(
    'No daemon socket. Run `agentigram tui --root <repo>`, or pass --socket <path>.\n' +
      'Start a room first with `agentigram create --root <repo>`.'
  )
  Bare.exit(1)
}

const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)
const model = cmd.flags.model || pkg.qvac.model
const ctxSize = Number(cmd.flags.ctx) || pkg.qvac.ctxSize
const verbose = cmd.flags.verbose === true

const inference = new Inference({ model, ctxSize, verbose })
const room = new Room({ socket })

const ui = new UI({ inference, room, model, version: pkg.version })
const program = new Program(ui, { mouse: true })

// ── bridge ────────────────────────────────────────────────────────────────
//
// Everything the outside world has to say reaches the UI as a message. The UI
// model stays pure and synchronous; this is the only place the two meet.

inference.on('progress', (percentage) => program.send({ type: 'qvac.progress', percentage }))
inference.on('delta', (id, text) => program.send({ type: 'qvac.delta', id, text }))
inference.on('end', (id, stopReason) => program.send({ type: 'qvac.end', id, stopReason }))
inference.on('answer-error', (id, message) => repaint({ type: 'qvac.error', id, message }))
inference.on('error', (err) => repaint({ type: 'qvac.error', message: err.message }))

room.on('state', (state) => program.send({ type: 'room.state', state }))
room.on('event', (frame) => program.send({ type: 'room.event', frame }))
room.on('status', (status) => program.send({ type: 'room.status', status }))
room.on('warn', (text) => program.send({ type: 'room.warn', text }))

// Send a Msg *and* force the next frame to repaint every row.
//
// llama.cpp/ggml write their banner ("ggml_vulkan: Found 1 Vulkan devices…")
// straight to fd 2 with fprintf, below any JS logger — the SDK's `logger`
// option and `modelConfig.verbosity` don't gate them, and Bare has no dup2 to
// redirect the fd. Sharing our thread, they land on the alt-screen, and an
// alt-screen that scrolled puts every absolute row address the renderer uses
// permanently out. Nothing can stop the writes, so repair the display instead,
// at every point where the outside world has just finished talking to the fd.
function repaint(msg) {
  program.renderer.clear()
  program.send(msg)
}

inference.on('loaded', (loadedModel, loadedCtx) => {
  repaint({ type: 'qvac.loaded', model: loadedModel, ctxSize: loadedCtx })
})

// ── lifecycle ─────────────────────────────────────────────────────────────

function teardown() {
  return Promise.allSettled([inference.close(), room.close()])
}

async function shutdown(code = 0) {
  Bare.exitCode = code
  program.quit()
  await teardown()
}

process.on('SIGHUP', () => shutdown(129))
process.on('SIGINT', () => shutdown(130))
process.on('SIGQUIT', () => shutdown(131))
process.on('SIGTERM', () => shutdown(143))

try {
  // Kick both off without waiting — the TUI paints immediately and fills in as
  // the room and the model arrive. The room is the one that matters: a laptop
  // whose weights are still downloading still shows every collision, just with
  // deterministic wording.
  room.ready().catch((err) => program.send({ type: 'room.warn', text: err.message }))
  inference.ready().catch((err) => program.send({ type: 'qvac.error', message: err.message }))

  await program.run()
} finally {
  await teardown()
}

// `dir` is reserved for the OTA updater's storage once this app has a pear://
// key; referenced here so the flag keeps its meaning.
void dir
