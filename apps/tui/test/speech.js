// Headless tests for the speech engine: fake QVAC engine, fake playback, fake
// fs. No model, no audio device, no subprocess.
const { test } = require('brittle')
const EventEmitter = require('bare-events')
const { pcmToWav } = require('../lib/speech/wav.js')
const { voiceFor } = require('../lib/speech/voices.js')
const { Settings, DEFAULT_VOLUME } = require('../lib/speech/settings.js')
const { Player } = require('../lib/speech/player.js')
const { Speech } = require('../lib/speech/index.js')
const SpeechEngine = require('../lib/speech/engine.js')
const { decodePcm } = SpeechEngine

function memfs(files = {}) {
  return {
    files,
    readFileSync(f) {
      if (!(f in files)) throw new Error('ENOENT')
      return files[f]
    },
    writeFileSync(f, data) {
      files[f] = data
    },
    unlinkSync(f) {
      if (!(f in files)) throw new Error('ENOENT')
      delete files[f]
    },
    mkdirSync() {}
  }
}

// An engine whose synthesis the test finishes by hand.
function fakeEngine() {
  const engine = new EventEmitter()
  engine.spoken = []
  engine.pending = []
  engine.cancels = 0
  engine.closed = false
  engine.synthesize = (text, description) => {
    engine.spoken.push({ text, description })
    return new Promise((resolve, reject) => engine.pending.push({ resolve, reject }))
  }
  engine.finish = () => engine.pending.shift().resolve({ samples: [1, 2, 3], sampleRate: 44100 })
  engine.cancel = () => {
    engine.cancels++
    const err = new Error('cancelled')
    err.cancelled = true
    for (const p of engine.pending.splice(0)) p.reject(err)
  }
  engine.close = () => {
    engine.closed = true
    return Promise.resolve()
  }
  return engine
}

function fakePlayer() {
  const player = { plays: [], stops: 0, closed: false }
  player.play = (samples, rate, volume) => {
    let end
    const done = new Promise((resolve) => {
      end = resolve
    })
    const playback = {
      done,
      end,
      stop() {
        player.stops++
        end()
      }
    }
    player.plays.push({ samples, rate, volume, playback })
    return playback
  }
  player.close = () => {
    player.closed = true
  }
  return player
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function setup({ maxQueue, local = 'codex', voiced } = {}) {
  const engine = fakeEngine()
  const player = fakePlayer()
  const settings = new Settings(null)
  const speech = new Speech({ engine, player, settings, maxQueue })
  speech.setLocalSession(local)
  if (voiced) speech.setVoicedSessions(voiced)
  const events = []
  for (const name of ['queued', 'started', 'finished', 'muted', 'error', 'ready', 'progress']) {
    speech.on(name, (e) => events.push([name, e]))
  }
  const queue = []
  speech.on('queue', (snapshot) => queue.push(snapshot))
  return { engine, player, settings, speech, events, queue }
}

test('speech: wav header has the reported sample rate and length', (t) => {
  const wav = pcmToWav([0, 1000, -1000, 32767], 44100)
  t.is(wav.length, 44 + 8)
  t.is(wav.toString('ascii', 0, 4), 'RIFF')
  t.is(wav.toString('ascii', 8, 12), 'WAVE')
  t.is(wav.readUInt16LE(20), 1, 'PCM')
  t.is(wav.readUInt16LE(22), 1, 'mono')
  t.is(wav.readUInt32LE(24), 44100, 'sample rate')
  t.is(wav.readUInt32LE(28), 88200, 'byte rate')
  t.is(wav.readUInt16LE(34), 16, 'bits')
  t.is(wav.readUInt32LE(40), 8, 'data bytes')
  t.is(wav.readInt16LE(44 + 4), -1000)
  t.exception(() => pcmToWav([0], 0), /sample rate/)
})

test('speech: base64 PCM transport preserves signed 16-bit samples', (t) => {
  const source = Int16Array.from([-32768, -1, 0, 1, 32767])
  const encoded = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString(
    'base64'
  )
  t.alike(Array.from(decodePcm(encoded)), Array.from(source))
  t.exception(() => decodePcm(''), /invalid PCM/)
})

test('speech: first synthesis waits until the worker reports ready', async (t) => {
  const engine = new SpeechEngine()
  const sent = []
  engine.ready = () => Promise.resolve()
  engine.pipe = { write() {} }
  engine._send = (message) => sent.push(message)
  const result = engine.synthesize('hello', 'voice')
  await tick()
  t.is(sent.length, 0, 'not sent while the model is loading')
  engine._onmessage(Buffer.from(JSON.stringify({ t: 'ready', gpu: true })))
  await tick()
  t.is(sent[0].t, 'speak')
  const samples = Int16Array.from([1, -2, 3])
  engine._onmessage(
    Buffer.from(
      JSON.stringify({
        t: 'audio',
        id: sent[0].id,
        pcm: Buffer.from(samples.buffer).toString('base64'),
        sampleRate: 44100
      })
    )
  )
  t.alike(Array.from((await result).samples), [1, -2, 3])
})

test('speech: voices are stable and differ across agents', (t) => {
  t.is(voiceFor('backend'), voiceFor('backend'))
  const voices = new Set(['backend', 'payments', 'frontend', 'infra', 'qa', 'docs'].map(voiceFor))
  t.ok(voices.size > 1)
  t.ok(voiceFor('x').length > 20)
})

test('speech: settings default, persist and survive a restart', (t) => {
  const fs = memfs()
  const a = new Settings('/store', { fsImpl: fs })
  t.is(a.volume, DEFAULT_VOLUME)
  t.is(a.isMuted('codex', true), false, 'a voiced agent speaks')
  t.is(a.isMuted('claude', false), true, 'an agent this laptop does not voice is muted')
  a.setMuted('claude', false)
  a.setVolume(0.3)
  const b = new Settings('/store', { fsImpl: fs })
  t.is(b.volume, 0.3)
  t.is(b.isMuted('claude', false), false, 'manual unmute persisted')
  a.setMuted('codex', true)
  t.is(a.isMuted('codex', true), true, 'a manual mute overrides the default too')
  const corrupt = new Settings('/store', { fsImpl: memfs({ '/store/speech.json': '{bad' }) })
  t.is(corrupt.volume, 0.8)
})

test('speech: speaks the local agent, skips muted remote, dedupes by seq', async (t) => {
  const { engine, player, speech } = setup()
  t.is(speech.enqueue({ seq: 1, speaker: 'claude', text: 'remote', priority: 1 }), false)
  t.is(speech.enqueue({ seq: 2, speaker: 'codex', text: 'hello', priority: 1 }), true)
  t.is(speech.enqueue({ seq: 2, speaker: 'codex', text: 'hello', priority: 1 }), false, 'dup')
  await tick()
  t.is(engine.spoken.length, 1)
  t.is(engine.spoken[0].text, 'hello')
  t.is(engine.spoken[0].description, voiceFor('codex'))
  engine.finish()
  await tick()
  t.is(player.plays.length, 1)
  t.is(player.plays[0].rate, 44100)
  t.is(player.plays[0].volume, 0.8)
  player.plays[0].playback.end()
  await tick()
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'hello', priority: 1 })
  await tick()
  t.is(engine.spoken.length, 1, 'a spoken seq never repeats')
})

test('speech: the authority voices the whole room, a peer only its own agent', async (t) => {
  // The orchestrator runs on the authority and negotiates on behalf of agents
  // whose laptop is not here to speak for them, so the machine conducting the
  // debate has to be able to hear both sides of it.
  const authority = setup({ local: 'backend', voiced: ['backend', 'payments'] })
  t.is(authority.speech.enqueue({ seq: 1, speaker: 'payments', text: 'I have read User.id' }), true)
  await tick()
  t.is(authority.engine.spoken[0].text, 'I have read User.id')

  const peer = setup({ local: 'backend' })
  t.is(peer.speech.enqueue({ seq: 1, speaker: 'payments', text: 'I have read User.id' }), false)
  await tick()
  t.is(peer.engine.spoken.length, 0, 'a peer does not repeat a remote agent')
})

test('speech: the room speaks for itself and cannot be silenced by default', async (t) => {
  // Lines the orchestrator publishes as the room have no session, so they match
  // no agent row — a default mute would leave no button to turn them back on.
  const { engine, speech, settings } = setup({ local: 'backend' })
  t.is(speech.isMuted('agentigram'), false)
  speech.enqueue({ seq: 1, speaker: 'agentigram', text: 'The debate is settled.', priority: 2 })
  await tick()
  t.is(engine.spoken[0].text, 'The debate is settled.')
  speech.mute('agentigram', true)
  t.is(settings.muted.agentigram, true, 'it is still mutable on purpose')
})

test('speech: the queue snapshot names a speaker before there is any audio', async (t) => {
  const { engine, player, speech, queue } = setup({ local: 'backend', voiced: ['payments'] })
  speech.enqueue({ seq: 1, speaker: 'payments', text: 'first' })
  speech.enqueue({ seq: 2, speaker: 'backend', text: 'second' })
  await tick()
  const beforeAudio = queue.at(-1)
  t.is(beforeAudio.preparing, 'payments', 'named while synthesis is still running')
  t.is(beforeAudio.speaking, null, 'nothing is playing yet')
  t.alike(beforeAudio.pending, ['backend'], 'and the line behind it is named too')
  t.is(player.plays.length, 0)

  engine.finish()
  await tick()
  const playing = queue.at(-1)
  t.is(playing.speaking, 'payments')
  t.is(playing.preparing, null)

  player.plays[0].playback.end()
  await tick()
  t.is(queue.at(-1).preparing, 'backend', 'the next speaker is claimed immediately')
})

test('speech: warm loads the model before anything is queued', async (t) => {
  const { engine, speech } = setup()
  let loads = 0
  engine.ensureLoaded = () => {
    loads++
    return Promise.resolve()
  }
  await speech.warm()
  t.is(loads, 1, 'the model starts downloading before the first line')
  t.is(engine.spoken.length, 0, 'and nothing was spoken to trigger it')
})

test('speech: lines are serialized', async (t) => {
  const { engine, player, speech } = setup()
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'one' })
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'two' })
  await tick()
  t.is(engine.spoken.length, 1, 'second waits for the first')
  engine.finish()
  await tick()
  player.plays[0].playback.end()
  await tick()
  t.is(engine.spoken.length, 2)
})

test('speech: urgent interrupts lower-priority playback', async (t) => {
  const { engine, player, speech, events } = setup()
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'routine', priority: 0 })
  await tick()
  engine.finish()
  await tick()
  t.is(player.plays.length, 1)
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'collision!', priority: 3 })
  await tick()
  t.is(player.stops, 1, 'routine stopped')
  t.ok(events.some(([n, e]) => n === 'finished' && e.interrupted))
  t.is(engine.spoken[1].text, 'collision!')
})

test('speech: urgent does not interrupt urgent', async (t) => {
  const { engine, player, speech } = setup()
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'a', priority: 3 })
  await tick()
  engine.finish()
  await tick()
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'b', priority: 3 })
  await tick()
  t.is(player.stops, 0)
})

test('speech: cancelling synthesis for an interrupt is not an error', async (t) => {
  const { engine, speech, events } = setup()
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'slow', priority: 0 })
  await tick()
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'now', priority: 3 })
  await tick()
  t.is(engine.cancels, 1)
  t.absent(events.some(([n]) => n === 'error'))
  t.is(engine.spoken[1].text, 'now')
})

test('speech: queue cap drops the oldest lowest-priority line first', async (t) => {
  const { engine, speech } = setup({ maxQueue: 2 })
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'busy', priority: 1 })
  await tick() // seq 1 is now in synthesis, so the queue itself is empty
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'low-old', priority: 0 })
  speech.enqueue({ seq: 3, speaker: 'codex', text: 'high', priority: 2 })
  speech.enqueue({ seq: 4, speaker: 'codex', text: 'low-new', priority: 0 })
  t.is(speech._queue.length, 2)
  t.alike(speech._queue.map((i) => i.text).sort(), ['high', 'low-new'])
  t.is(engine.spoken.length, 1)
})

test('speech: muting removes queued speech and stops active playback', async (t) => {
  const { engine, player, speech, events } = setup()
  speech.setLocalSession('other')
  speech.mute('codex', false)
  speech.mute('claude', false)
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'playing' })
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'queued codex' })
  speech.enqueue({ seq: 3, speaker: 'claude', text: 'queued claude' })
  await tick()
  engine.finish()
  await tick()
  speech.mute('codex', true)
  await tick()
  t.is(player.stops, 1, 'active playback stopped')
  t.ok(events.some(([n, e]) => n === 'muted' && e.sessionId === 'codex' && e.muted))
  t.is(engine.spoken.length, 2)
  t.is(engine.spoken[1].text, 'queued claude', 'codex line dropped, claude line still speaks')
})

test('speech: toggle flips the mute and persists it', (t) => {
  const { speech, settings } = setup()
  t.is(speech.isMuted('claude'), true)
  speech.toggle('claude')
  t.is(speech.isMuted('claude'), false)
  t.is(settings.muted.claude, false)
})

test('speech: synthesis failure is reported and does not stall the queue', async (t) => {
  const { engine, speech, events } = setup()
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'bad' })
  speech.enqueue({ seq: 2, speaker: 'codex', text: 'good' })
  await tick()
  engine.pending.shift().reject(new Error('model crashed'))
  await tick()
  t.ok(events.some(([n, e]) => n === 'error' && /model crashed/.test(e.message)))
  t.is(engine.spoken[1].text, 'good')
})

test('speech: forwards engine progress, ready and failure', (t) => {
  const { engine, events } = setup()
  engine.emit('progress', 42)
  engine.emit('loaded', true)
  engine.emit('failure', new Error('no model'))
  t.alike(
    events.map(([n]) => n),
    ['progress', 'ready', 'error']
  )
})

test('speech: close cancels, sweeps playback and closes the engine; later lines are refused', async (t) => {
  const { engine, player, speech } = setup()
  speech.enqueue({ seq: 1, speaker: 'codex', text: 'x' })
  await tick()
  await speech.close()
  t.ok(engine.closed)
  t.ok(player.closed)
  t.is(speech.enqueue({ seq: 9, speaker: 'codex', text: 'late' }), false)
})

test('speech: player writes a wav, spawns afplay without a shell, and always cleans up', async (t) => {
  const fs = memfs()
  const spawned = []
  let exit
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter()
    child.kill = () => exit(0)
    exit = (code) => child.emit('exit', code)
    spawned.push({ bin, args, opts, child })
    return child
  }
  const player = new Player({ tmpdir: '/tmp', spawnImpl, fsImpl: fs })

  const a = player.play([1, 2], 44100, 0.8)
  const file = spawned[0].args[2]
  t.is(spawned[0].bin, '/usr/bin/afplay')
  t.alike(spawned[0].args.slice(0, 2), ['-v', '0.8'])
  t.is(fs.files[file].readUInt32LE(24), 44100, 'wav on disk')
  t.absent(spawned[0].opts.shell)
  exit(0)
  await a.done
  t.absent(file in fs.files, 'deleted on completion')

  const b = player.play([1], 44100, 1)
  const failing = b.done.catch((e) => e.message)
  exit(1)
  t.ok(/exited with code 1/.test(await failing))
  t.is(Object.keys(fs.files).length, 0, 'deleted on failure')

  const c = player.play([1], 44100, 1)
  c.stop()
  await c.done
  t.is(Object.keys(fs.files).length, 0, 'deleted on stop')

  player.play([1], 44100, 1)
  t.is(Object.keys(fs.files).length, 1)
  player.close()
  t.is(Object.keys(fs.files).length, 0, 'swept on shutdown')
})

test('speech: player cleans up when spawn itself throws', async (t) => {
  const fs = memfs()
  const player = new Player({
    tmpdir: '/tmp',
    fsImpl: fs,
    spawnImpl() {
      throw new Error('ENOENT afplay')
    }
  })
  await t.exception(player.play([1], 44100, 1).done, /ENOENT/)
  t.is(Object.keys(fs.files).length, 0)
})
