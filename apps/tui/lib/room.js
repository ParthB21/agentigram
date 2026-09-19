// Room — the TUI-side handle on the Agentigram daemon.
//
// Same shape as lib/inference.js: a ReadyResource that owns a connection, wraps
// it in a line protocol, and turns frames into events. The daemon is a Node
// process on this same laptop; it owns the Hyperswarm room, the Hypercore
// history, the agent hooks and the TypeScript analysis. Nothing here reaches
// the network — the socket is local, and everything that crosses a machine
// boundary has already been validated and redacted on the other side of it.
//
//   const room = new Room({ socket: '\\\\.\\pipe\\agentigram-abc' })
//   room.on('state', (state) => ...)   // whole-room snapshot
//   room.on('event', (frame) => ...)   // one line of history
//   room.on('status', (status) => ...) // 'connected' | 'retrying'
//   await room.ready()
//
//   await room.narrate([{ speaker: 'backend', text: '...' }])
//   await room.propose(collisionId, contract, sessionId)
const Pipe = require('bare-pipe')
const ReadyResource = require('ready-resource')

// The daemon drops a subscriber the moment its socket closes, so reconnecting
// is the whole recovery story: a fresh subscribe replays current state.
const RETRY_MS = 1000
const REQUEST_TIMEOUT_MS = 5000

module.exports = class Room extends ReadyResource {
  constructor({ socket } = {}) {
    super()

    if (!socket) throw new Error('Room requires a daemon socket path')
    this.socket = socket
    this.state = null
    this.status = 'connecting'

    this._stream = null
    this._buffer = ''
    this._retry = null
  }

  _open() {
    this._connect()
  }

  async _close() {
    if (this._retry) {
      clearTimeout(this._retry)
      this._retry = null
    }
    const stream = this._stream
    this._stream = null
    stream?.destroy()
  }

  // ── the subscription ──────────────────────────────────────────────────────

  _connect() {
    if (this.closing || this.closed) return

    let stream
    try {
      stream = new Pipe(this.socket)
    } catch (err) {
      this._retryLater(err)
      return
    }

    this._stream = stream
    this._buffer = ''

    stream.on('connect', () => {
      this._setStatus('connected')
      stream.write(JSON.stringify({ type: 'subscribe' }) + '\n')
    })
    stream.on('data', (data) => this._ondata(data))
    // A daemon that is restarting, or not up yet, is the normal case at demo
    // time — retry quietly rather than taking the UI down.
    stream.on('error', (err) => this._retryLater(err))
    stream.on('close', () => this._retryLater(null))
  }

  _retryLater(err) {
    if (this.closing || this.closed || this._retry) return
    this._stream = null
    this._setStatus('retrying')
    if (err) this.emit('warn', err.message)
    this._retry = setTimeout(() => {
      this._retry = null
      this._connect()
    }, RETRY_MS)
  }

  _setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  _ondata(data) {
    this._buffer += data.toString()
    let newline = this._buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this._buffer.slice(0, newline)
      this._buffer = this._buffer.slice(newline + 1)
      if (line.trim()) this._onframe(line)
      newline = this._buffer.indexOf('\n')
    }
  }

  _onframe(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.t === 'state') {
      this.state = frame.state
      this.emit('state', frame.state)
    } else if (frame.t === 'event') {
      this.emit('event', frame)
    }
  }

  // ── requests ──────────────────────────────────────────────────────────────

  // Each request is its own short-lived connection: the subscription socket is
  // a one-way stream of frames, and multiplexing replies onto it would mean
  // matching responses to requests for no gain.
  _request(payload) {
    return new Promise((resolve, reject) => {
      let stream
      try {
        stream = new Pipe(this.socket)
      } catch (err) {
        reject(err)
        return
      }

      let buffer = ''
      let settled = false
      const finish = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stream.destroy()
        if (err) reject(err)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('daemon did not answer')), REQUEST_TIMEOUT_MS)

      stream.on('connect', () => stream.write(JSON.stringify(payload) + '\n'))
      stream.on('data', (data) => {
        buffer += data.toString()
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const response = JSON.parse(buffer.slice(0, newline))
          if (response.ok) finish(null, response.output)
          else finish(new Error(response.error || 'daemon rejected the request'))
        } catch (err) {
          finish(err)
        }
      })
      stream.on('error', (err) => finish(err))
      stream.on('close', () => finish(new Error('daemon closed the connection')))
    })
  }

  status_() {
    return this._request({ type: 'status' })
  }

  /**
   * Dialogue from the on-device model. Lands as PERSONA_LINES, which is
   * dashboard-only — so what a local 1B model writes reaches the room view and
   * never an agent's context.
   */
  narrate(lines) {
    return this._request({ type: 'narrate', lines })
  }

  /**
   * A contract the on-device model drafted, sent as a real PROPOSAL. This one
   * *is* agent-visible, which is exactly why the UI gates it behind a keypress.
   */
  propose(collisionId, contract, sessionId) {
    return this._request({
      type: 'tool',
      name: 'propose',
      args: { collisionId, contract },
      sessionId
    })
  }
}
