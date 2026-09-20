// Volume and per-agent mute, kept under the app's existing storage directory.
//
// Defaults are decided by the caller and passed in as `speaksByDefault`, because
// which agents a laptop is responsible for voicing depends on its room role. A
// stored mute for a session overrides the default either way, so a manual mute
// or unmute survives a restart.
const fs = require('bare-fs')
const path = require('bare-path')

const FILE = 'speech.json'
const DEFAULT_VOLUME = 0.8

class Settings {
  constructor(dir, { fsImpl = fs } = {}) {
    this.file = dir ? path.join(dir, FILE) : null
    this.fs = fsImpl
    this.volume = DEFAULT_VOLUME
    this.muted = {} // sessionId -> boolean, explicit choices only
    this._load()
  }

  _load() {
    if (!this.file) return
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'))
      if (typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1) {
        this.volume = raw.volume
      }
      if (raw.muted && typeof raw.muted === 'object') {
        for (const [id, value] of Object.entries(raw.muted)) {
          if (typeof value === 'boolean') this.muted[id] = value
        }
      }
    } catch {
      // Missing or corrupt: fall back to defaults. Settings are a convenience.
    }
  }

  isMuted(sessionId, speaksByDefault) {
    if (sessionId in this.muted) return this.muted[sessionId]
    return !speaksByDefault
  }

  setMuted(sessionId, muted) {
    this.muted[sessionId] = muted
    this._save()
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume))
    this._save()
  }

  _save() {
    if (!this.file) return
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true })
      this.fs.writeFileSync(this.file, JSON.stringify({ volume: this.volume, muted: this.muted }))
    } catch {
      // A read-only disk must not break speech.
    }
  }
}

module.exports = { Settings, DEFAULT_VOLUME }
