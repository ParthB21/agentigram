// Speech worker — owns the QVAC Parler TTS model.
//
// Its own Bare thread, like workers/qvac.js and for the same reasons: loading
// a ~1.1 GB model blocks a thread for seconds, and a native crash must take
// down this thread, not the terminal or the negotiation model.
//
//   in   { t: 'speak',  id, text, description }
//        { t: 'cancel' }
//        { t: 'close' }
//
//   out  { t: 'progress', percentage }       model download, 0-100
//        { t: 'ready', gpu }                 model resident
//        { t: 'audio', id, samples, sampleRate }   signed 16-bit mono PCM
//        { t: 'error', id?, message }
//        { t: 'closed' }
const FramedStream = require('framed-stream')
const os = require('bare-os')

const MODEL = 'TTS_MINI_V1_EN_PARLER_TTS_Q8_0'
// Pinned rather than discovered: the client API does not report the rate, and
// Parler's codec is native 44.1 kHz. Setting it makes the WAV header a fact.
const SAMPLE_RATE = 44100

const pipe = new FramedStream(Bare.IPC)
const send = (msg) => pipe.write(JSON.stringify(msg))

let sdk = null
let modelId = null
let gpu = false
let closing = null

function load(useGPU) {
  return sdk.loadModel({
    modelSrc: sdk[MODEL],
    modelType: 'tts-ggml',
    modelConfig: { ttsEngine: 'parler', useGPU, outputSampleRate: SAMPLE_RATE },
    onProgress: ({ percentage }) => send({ t: 'progress', percentage })
  })
}

async function boot() {
  sdk = await import('@qvac/inference')
  const { ttsPlugin } = await import('@qvac/inference/tts-ggml/plugin')
  sdk.registerPlugin(ttsPlugin)
  if (!sdk[MODEL]) throw new Error(`Unknown model: ${MODEL}`)

  // Metal on Apple Silicon; if it will not load, retry once on the CPU.
  const metal = os.platform() === 'darwin' && os.arch() === 'arm64'
  if (metal) {
    try {
      modelId = await load(true)
      gpu = true
    } catch {
      modelId = null
    }
  }
  if (!modelId) modelId = await load(false)
  send({ t: 'ready', gpu })
}

async function speak(id, text, description) {
  try {
    const run = sdk.textToSpeech({ modelId, text, stream: false, description })
    const samples = await run.buffer
    await run.done
    send({ t: 'audio', id, samples, sampleRate: SAMPLE_RATE })
  } catch (err) {
    send({ t: 'error', id, message: err.message })
  }
}

function shutdown() {
  if (closing) return closing
  closing = (async () => {
    try {
      if (sdk) {
        if (modelId) await sdk.unloadModel({ modelId })
        await sdk.close()
      }
    } catch {}
    send({ t: 'closed' })
  })()
  return closing
}

pipe.on('data', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  if (msg.t === 'speak') speak(msg.id, msg.text, msg.description)
  else if (msg.t === 'cancel') sdk?.cancel({ modelId }).catch(() => {})
  else if (msg.t === 'close') shutdown()
})

boot().catch((err) => send({ t: 'error', message: err.message }))
