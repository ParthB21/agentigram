// Speech — the controller the TUI talks to.
//
//   const speech = new Speech({ engine, player, settings })
//   speech.setLocalSession('backend')
//   speech.setVoicedSessions(['backend', 'payments'])  // see below
//   speech.enqueue({ seq, speaker, text, priority })   // priority 0-3, 3 = urgent
//   speech.toggle(sessionId) · speech.mute(sessionId, true) · speech.cancel()
//   await speech.warm() · await speech.close()
//
// Events: progress, ready, queued, started, finished, muted, error, queue.
//
// One line at a time: synthesise, play, next. The engine and player are
// injected so all of the queue policy here is testable without a model.
//
// Which agents a laptop speaks for is set from outside, because it depends on
// the room role. A plain peer voices only its own coding agent, so one room
// message is not spoken by every machine. The authority also runs the
// orchestrator, which negotiates on behalf of agents whose laptop is not here
// to speak for them — so it is given the whole roster, and without that the
// debate it is conducting would be inaudible on the one machine running it.
const EventEmitter = require('bare-events')
const { voiceFor } = require('./voices.js')

const MAX_QUEUE = 8
const URGENT = 3
/**
 * The speaker the daemon attributes a line with no session of its own to. Never
 * muted by default: it is the room narrating its own decisions, and it appears
 * in no agent row, so there would be no button to turn it back on with.
 * Matches `SYSTEM_SPEAKER` in `apps/daemon/src/event-rendering.ts`.
 */
const SYSTEM_SPEAKER = 'agentigram'

class Speech extends EventEmitter {
  constructor({ engine, player, settings, maxQueue = MAX_QUEUE } = {}) {
    super()
    this.engine = engine
    this.player = player
    this.settings = settings
    this.maxQueue = maxQueue
    this.localSession = null
    this.voiced = new Set()
    this.closed = false

    this._queue = []
    this._seen = new Set()
    this._current = null // { item, playback, cancelled, playing }
    this._running = false

    engine.on('progress', (pct) => this.emit('progress', pct))
    engine.on('loaded', (gpu) => this.emit('ready', gpu))
    engine.on('failure', (err) => this.emit('error', err))
    engine.on('error', (err) => this.emit('error', err))
  }

  setLocalSession(sessionId) {
    this.localSession = sessionId
  }

  /** Every session this laptop is responsible for voicing, beyond its own agent. */
  setVoicedSessions(sessionIds) {
    this.voiced = new Set(sessionIds || [])
  }

  isMuted(sessionId) {
    return this.settings.isMuted(sessionId, this.speaksByDefault(sessionId))
  }

  /** Whether a speaker is heard here absent an explicit choice from the person watching. */
  speaksByDefault(sessionId) {
    return (
      sessionId === this.localSession || sessionId === SYSTEM_SPEAKER || this.voiced.has(sessionId)
    )
  }

  /**
   * Start loading the model before there is anything to say. The first line of a
   * debate is the one that explains it, and synthesis that begins by downloading
   * ~1.1 GB would miss the whole exchange.
   */
  warm() {
    if (this.closed) return Promise.resolve()
    return this.engine.ensureLoaded()
  }

  enqueue({ seq, speaker, text, priority = 0 }) {
    if (this.closed) return false
    // Dedupe on the replicated sequence number, whether or not it is spoken:
    // unmuting later must not replay what was skipped.
    if (this._seen.has(seq)) return false
    this._seen.add(seq)
    if (this.isMuted(speaker) || !String(text).trim()) return false

    const item = { seq, speaker, text: String(text), priority }
    this._queue.push(item)
    this._trim()
    if (!this._queue.includes(item)) return false
    this.emit('queued', { seq, speaker, priority })

    // Urgent cuts across whatever is being said, unless that is urgent too.
    if (priority >= URGENT && this._current && this._current.item.priority < URGENT) {
      this._interrupt()
    }
    this._announce()
    this._pump()
    return true
  }

  toggle(sessionId) {
    this.mute(sessionId, !this.isMuted(sessionId))
  }

  mute(sessionId, muted) {
    this.settings.setMuted(sessionId, muted)
    if (muted) {
      this._queue = this._queue.filter((item) => item.speaker !== sessionId)
      if (this._current?.item.speaker === sessionId) this._interrupt()
    }
    this.emit('muted', { sessionId, muted })
    this._announce()
  }

  cancel() {
    this._queue = []
    this._interrupt()
    this._announce()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.cancel()
    this.player.close()
    await this.engine.close()
  }

  // Cap the queue: evict the oldest of the lowest priority first, so a burst
  // of routine activity never pushes out a message someone should hear.
  _trim() {
    while (this._queue.length > this.maxQueue) {
      let victim = 0
      for (let i = 1; i < this._queue.length; i++) {
        if (this._queue[i].priority < this._queue[victim].priority) victim = i
      }
      this._queue.splice(victim, 1)
    }
  }

  _interrupt() {
    const current = this._current
    if (!current) return
    current.cancelled = true
    current.playback?.stop()
    this.engine.cancel()
  }

  async _pump() {
    if (this._running) return
    this._running = true
    try {
      while (!this.closed && this._queue.length > 0) {
        // Highest priority first; arrival order within a priority.
        let best = 0
        for (let i = 1; i < this._queue.length; i++) {
          if (this._queue[i].priority > this._queue[best].priority) best = i
        }
        const [item] = this._queue.splice(best, 1)
        await this._speak(item)
      }
    } finally {
      this._running = false
    }
  }

  async _speak(item) {
    const current = { item, playback: null, cancelled: false, playing: false }
    this._current = current
    // Claim the speaker before synthesis rather than after it. Synthesis takes
    // seconds, and an indicator that waits for audio is an indicator that names
    // the speaker once they have already started talking.
    this._announce()
    try {
      const { samples, sampleRate } = await this.engine.synthesize(
        item.text,
        voiceFor(item.speaker)
      )
      if (current.cancelled || this.closed) return
      current.playback = this.player.play(samples, sampleRate, this.settings.volume)
      current.playing = true
      this.emit('started', { seq: item.seq, speaker: item.speaker })
      this._announce()
      await current.playback.done
      if (!current.cancelled) this.emit('finished', { seq: item.seq, speaker: item.speaker })
    } catch (err) {
      // A cancelled line is an outcome, not a failure.
      if (!err?.cancelled && !current.cancelled) this.emit('error', err, item.speaker)
    } finally {
      // An interrupted line was started; say it is over so the UI clears it.
      if (current.cancelled && current.playback) {
        this.emit('finished', { seq: item.seq, speaker: item.speaker, interrupted: true })
      }
      this._current = null
      this._announce()
    }
  }

  /**
   * The whole of what is audible right now, as one snapshot: who is talking, who
   * is being synthesised, and who is behind them. Counting `queued` against
   * `finished` in the view instead would drift every time the cap evicts a line
   * or a mute empties the queue.
   */
  _announce() {
    const current = this._current
    this.emit('queue', {
      speaking: current?.playing ? current.item.speaker : null,
      preparing: current && !current.playing ? current.item.speaker : null,
      pending: [...this._queue].sort((a, b) => b.priority - a.priority).map((item) => item.speaker)
    })
  }
}

module.exports = { Speech, MAX_QUEUE, URGENT, SYSTEM_SPEAKER }
