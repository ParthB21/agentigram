// Engine — the UI-side handle on workers/tts.js. Same shape as lib/inference.js.
//
//   engine.on('progress', pct) · engine.on('ready', gpu) · engine.on('error', err)
//   const { samples, sampleRate } = await engine.synthesize(text, description)
//   engine.cancel()   // rejects the pending synthesis with err.cancelled
const FramedStream = require('framed-stream')
const PearRuntime = require('pear-runtime')
const ReadyResource = require('ready-resource')

module.exports = class SpeechEngine extends ReadyResource {
  constructor({ gracePeriod } = {}) {
    super()
    this.gracePeriod = gracePeriod ?? 5000
    this.IPC = null
    this.pipe = null
    this._seq = 0
    this._pending = new Map() // id -> { resolve, reject }
    this._loaded = new Promise((resolve, reject) => {
      this._onloaded = resolve
      this._onloaderror = reject
    })
    // Loading is intentionally lazy. Avoid an unhandled rejection when a
    // worker fails before the first line asks for readiness.
    this._loaded.catch(() => {})
    this._onclosed = null
    this._closed = new Promise((resolve) => {
      this._onclosed = resolve
    })
  }

  _open() {
    this.IPC = PearRuntime.run(require.resolve('../../workers/tts.js'), [])
    this.pipe = new FramedStream(this.IPC)
    this.pipe.on('data', (data) => this._onmessage(data))
    this.pipe.on('error', (err) => this.emit('error', err))
    this.IPC.on('error', (err) => this.emit('error', err))
    this.IPC.on('exit', (code) => {
      if (code === 0 || this.closing !== null || this.closed) return
      const err = new Error(`Speech worker exited with code ${code}`)
      this._onloaderror(err)
      this._failAll(err)
      this.emit('error', err)
    })
  }

  async _close() {
    const { pipe, IPC } = this
    this._failAll(cancelled())
    if (pipe !== null) {
      this._send({ t: 'close' })
      let timer = null
      const grace = new Promise((resolve) => {
        timer = setTimeout(resolve, this.gracePeriod)
      })
      try {
        await Promise.race([this._closed, grace])
      } finally {
        clearTimeout(timer)
      }
    }
    this.pipe = null
    this.IPC = null
    pipe?.destroy()
    IPC?.destroy()
  }

  _onmessage(data) {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    switch (msg.t) {
      case 'progress':
        this.emit('progress', msg.percentage)
        break
      case 'ready':
        this._onloaded(msg.gpu)
        this.emit('loaded', msg.gpu)
        break
      case 'audio': {
        const pending = this._pending.get(msg.id)
        this._pending.delete(msg.id)
        try {
          pending?.resolve({ samples: decodePcm(msg.pcm), sampleRate: msg.sampleRate })
        } catch (err) {
          pending?.reject(err)
        }
        break
      }
      case 'error': {
        const err = new Error(msg.message)
        const pending = msg.id === undefined ? null : this._pending.get(msg.id)
        if (pending) {
          this._pending.delete(msg.id)
          pending.reject(err)
        } else {
          this._onloaderror(err)
          this._failAll(err)
          this.emit('failure', err)
        }
        break
      }
      case 'closed':
        this._onclosed()
        break
    }
  }

  ensureLoaded() {
    return this.ready().then(() => this._loaded)
  }

  synthesize(text, description) {
    const id = ++this._seq
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this.ensureLoaded().then(
        () => {
          if (this._pending.has(id)) this._send({ t: 'speak', id, text, description })
        },
        (err) => {
          if (!this._pending.delete(id)) return
          reject(err)
        }
      )
    })
  }

  cancel() {
    if (this._pending.size === 0) return
    this._failAll(cancelled())
    this._send({ t: 'cancel' })
  }

  _failAll(err) {
    const pending = [...this._pending.values()]
    this._pending.clear()
    for (const p of pending) p.reject(err)
  }

  _send(msg) {
    if (this.pipe === null) return
    this.pipe.write(JSON.stringify(msg))
  }
}

function cancelled() {
  const err = new Error('speech cancelled')
  err.cancelled = true
  return err
}

function decodePcm(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('speech worker returned invalid PCM audio')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new Error('speech worker returned malformed PCM audio')
  }
  const samples = new Int16Array(bytes.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  return samples
}

module.exports.decodePcm = decodePcm
