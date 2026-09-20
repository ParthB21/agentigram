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
//        { t: 'audio', id, pcm, sampleRate }   base64 signed 16-bit mono PCM
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
let booting = null

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
  if (!closing) send({ t: 'ready', gpu })
}

async function speak(id, text, description) {
  try {
    const run = sdk.textToSpeech({ modelId, text, stream: false, description })
    const samples = await run.buffer
    await run.done
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new Error('QVAC returned no PCM samples')
    }
    if (samples.some((sample) => !Number.isFinite(sample))) {
      throw new Error('QVAC returned non-numeric PCM samples')
    }
    const pcm = Int16Array.from(samples, (sample) =>
      Math.max(-32768, Math.min(32767, Math.round(Number(sample))))
    )
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    send({ t: 'audio', id, pcm: bytes.toString('base64'), sampleRate: SAMPLE_RATE })
  } catch (err) {
    send({ t: 'error', id, message: err?.message || String(err) })
  }
}

function shutdown() {
  if (closing) return closing
  closing = (async () => {
    try {
      await booting?.catch(() => {})
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

booting = boot()
booting.catch((err) => {
  if (!closing) send({ t: 'error', message: err?.message || String(err) })
})
