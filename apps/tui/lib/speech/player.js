// Playback: write a temp WAV, hand it to macOS afplay, delete it afterwards.
//
// afplay is spawned with an argument array and no shell, so nothing from a
// peer's message can reach a command line. Temp files are tracked so shutdown
// can sweep any a crash left behind.
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const { pcmToWav } = require('./wav.js')

const AFPLAY = '/usr/bin/afplay'

class Player {
  constructor({ tmpdir, spawnImpl = spawn, fsImpl = fs, bin = AFPLAY } = {}) {
    this.tmpdir = tmpdir || os.tmpdir()
    this.spawn = spawnImpl
    this.fs = fsImpl
    this.bin = bin
    this._n = 0
    this._files = new Set()
    this._children = new Set()
  }

  // Returns { done, stop }. `done` resolves when playback ends (or is stopped)
  // and rejects if afplay could not run; the temp file is gone either way.
  play(samples, sampleRate, volume) {
    const file = path.join(
      this.tmpdir,
      `agentigram-speech-${Date.now()}-${++this._n}-${Math.random().toString(36).slice(2, 8)}.wav`
    )
    this._files.add(file)

    let child = null
    let stopped = false
    const cleanup = () => {
      if (child) this._children.delete(child)
      this._remove(file)
    }

    const done = new Promise((resolve, reject) => {
      try {
        this.fs.writeFileSync(file, pcmToWav(samples, sampleRate))
        child = this.spawn(this.bin, ['-v', String(volume), file], { stdio: 'ignore' })
      } catch (err) {
        cleanup()
        reject(err)
        return
      }
      this._children.add(child)
      child.on('error', (err) => {
        cleanup()
        reject(err)
      })
      child.on('exit', (code) => {
        cleanup()
        if (code === 0 || stopped) resolve()
        else reject(new Error(`afplay exited with code ${code}`))
      })
    })

    return {
      done,
      stop: () => {
        stopped = true
        try {
          child?.kill()
        } catch {}
      }
    }
  }

  _remove(file) {
    this._files.delete(file)
    try {
      this.fs.unlinkSync(file)
    } catch {}
  }

  close() {
    for (const child of this._children) {
      try {
        child.kill()
      } catch {}
    }
    this._children.clear()
    for (const file of [...this._files]) this._remove(file)
  }
}

module.exports = { Player, AFPLAY }
