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
import SpeechEngine from './lib/speech/engine.js'
import SpeechModule from './lib/speech/index.js'
import PlayerModule from './lib/speech/player.js'
import SettingsModule from './lib/speech/settings.js'
import { App as UI } from './ui/app.js'

const { Speech } = SpeechModule
const { Player } = PlayerModule
const { Settings } = SettingsModule

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--socket <path>', 'Agentigram daemon socket (default: $AGENTIGRAM_SOCKET)'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--model <name>', 'QVAC model constant to load'),
  flag('--model-src <path>', 'load weights from this path/URL instead of the QVAC registry'),
  flag('--fallback-src <url>', 'fall back to this URL if the QVAC registry is unreachable'),
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
    'No daemon socket. Run `agg start` from the repository, or pass --socket <path>.\n' +
      'Start a room first with `agg create <session>`.'
  )
  Bare.exit(1)
}

const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)
const model = cmd.flags.model || pkg.qvac.model
const ctxSize = Number(cmd.flags.ctx) || pkg.qvac.ctxSize
const verbose = cmd.flags.verbose === true

const inference = new Inference({
  model,
  modelSrc: cmd.flags.modelSrc,
  fallbackSrc: cmd.flags.fallbackSrc,
  ctxSize,
  verbose
})
const room = new Room({ socket })
const speechEngine = new SpeechEngine()
const speech = new Speech({
  engine: speechEngine,
  player: new Player(),
  settings: new Settings(dir)
})

const ui = new UI({ inference, room, speech, model, version: pkg.version })
const program = new Program(ui, { mouse: true })
let inferenceStarted = false
let speechFloor = null

// ── bridge ────────────────────────────────────────────────────────────────
//
// Everything the outside world has to say reaches the UI as a message. The UI
// model stays pure and synchronous; this is the only place the two meet.

inference.on('progress', (percentage) => program.send({ type: 'qvac.progress', percentage }))
inference.on('delta', (id, text) => program.send({ type: 'qvac.delta', id, text }))
inference.on('end', (id, stopReason) => program.send({ type: 'qvac.end', id, stopReason }))
inference.on('answer-error', (id, message) => repaint({ type: 'qvac.error', id, message }))
inference.on('error', (err) => repaint({ type: 'qvac.error', message: err.message }))

room.on('state', (state) => {
  program.send({ type: 'room.state', state })
  speech.setLocalSession(state.sessionId)
  // The authority is where the orchestrator negotiates, and it negotiates for
  // agents whose laptop is not here to be their voice. It therefore speaks the
  // whole room; a peer speaks only its own agent, so a message is not read out
  // by every machine at once.
  speech.setVoiceAll(state.mode === 'authority')
  if (speechFloor === null) speechFloor = state.lastSeq
  if (state.mode === 'authority' && !inferenceStarted) {
    inferenceStarted = true
    inference.ready().catch((err) => program.send({ type: 'qvac.error', message: err.message }))
  }
})
room.on('event', (frame) => {
  program.send({ type: 'room.event', frame })
  if (frame.speech && speechFloor !== null && frame.seq > speechFloor) {
    // The daemon resolves the speaker: the session id where there is one, and
    // the room's own name where there is not.
    speech.enqueue({
      seq: frame.seq,
      speaker: frame.speech.speaker,
      text: frame.speech.text,
      priority: frame.speech.priority
    })
  }
})
room.on('status', (status) => program.send({ type: 'room.status', status }))
room.on('warn', (text) => program.send({ type: 'room.warn', text }))

speech.on('progress', (percentage) => program.send({ type: 'speech.progress', percentage }))
speech.on('ready', (gpu) => repaint({ type: 'speech.ready', gpu }))
speech.on('queued', ({ speaker }) => program.send({ type: 'speech.queued', sessionId: speaker }))
speech.on('queue', ({ speaking, preparing, pending }) =>
  program.send({ type: 'speech.queue', speaking, preparing, pending })
)
speech.on('started', ({ speaker }) => program.send({ type: 'speech.started', sessionId: speaker }))
speech.on('finished', ({ speaker, interrupted }) =>
  program.send({ type: 'speech.finished', sessionId: speaker, interrupted })
)
speech.on('muted', ({ sessionId, muted }) =>
  program.send({ type: 'speech.muted', sessionId, muted })
)
speech.on('error', (err, sessionId) =>
  repaint({ type: 'speech.error', message: err.message, sessionId })
)

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
  const resources = [room.close(), speech.close()]
  if (inferenceStarted) resources.push(inference.close())
  return Promise.allSettled(resources)
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
  // The room decides this laptop's role. Only an authority starts QVAC; peers
  // remain lightweight room participants. The authority-only model is the
  // boundary for a future orchestrator, not an autonomous orchestrator yet.
  room.ready().catch((err) => program.send({ type: 'room.warn', text: err.message }))

  // Unlike the negotiation model, the voice is not authority-only: every laptop
  // speaks at least its own agent. Load it now so the first line of a debate is
  // heard rather than spent downloading. Failures arrive on the 'error' event.
  speech.warm().catch(() => {})

  await program.run()
} finally {
  await teardown()
}

// `dir` is reserved for the OTA updater's storage once this app has a pear://
// key; referenced here so the flag keeps its meaning.
void dir
