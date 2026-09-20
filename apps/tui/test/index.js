// Headless tests for the room view and the negotiator.
//
// The whole point of keeping ui/app.js pure and lib/negotiator.js free of the
// QVAC SDK is that the entire negotiation — collision in, explanation and
// contract out, proposal sent — can be driven here with no model, no daemon, no
// network and no terminal. These run in ~150ms.
const { test } = require('brittle')
const { style } = require('bare-tui')
const { App } = require('../ui/app.js')
const {
  contractPrompt,
  explainPrompt,
  fallbackContract,
  parseContract,
  parseSymbolKey,
  tidyExplanation
} = require('../lib/negotiator.js')

// Stand-ins for lib/inference.js and lib/room.js: record what the UI asked for
// and let the test push answers back.
function fakeInference() {
  const calls = { asked: [], formats: [] }
  return {
    calls,
    ask(history, responseFormat) {
      calls.asked.push(history)
      calls.formats.push(responseFormat || null)
      return calls.asked.length
    },
    cancel() {}
  }
}

function fakeRoom({ fail = false } = {}) {
  const calls = { narrated: [], proposed: [] }
  return {
    calls,
    async narrate(lines) {
      calls.narrated.push(lines)
      if (fail) throw new Error('daemon is gone')
    },
    async propose(collisionId, contract, sessionId) {
      calls.proposed.push({ collisionId, contract, sessionId })
      if (fail) throw new Error('daemon is gone')
    }
  }
}

/**
 * Fake speech controller that records calls and can simulate controller events.
 * Mirrors the Speech interface from Part 2.
 */
function fakeSpeech() {
  const calls = { enqueued: [], toggled: [], muted: [], cancelled: 0, closed: 0 }
  const choices = new Map()
  return {
    calls,
    isMuted(sessionId) {
      if (choices.has(sessionId)) return choices.get(sessionId)
      return sessionId !== 'backend'
    },
    enqueue(item) {
      calls.enqueued.push(item)
    },
    toggle(sessionId) {
      calls.toggled.push(sessionId)
    },
    async mute(sessionId, muted) {
      calls.muted.push({ sessionId, muted })
      choices.set(sessionId, muted)
    },
    cancel() {
      calls.cancelled++
    },
    close() {
      calls.closed++
    }
  }
}

// Run Cmds the way the Program would, including the async ones.
async function drive(app, msgs) {
  for (const msg of msgs) {
    const [next, cmd] = app.update(msg)
    app = next
    for (const one of [].concat(cmd || [])) {
      if (typeof one !== 'function') continue
      const out = await one()
      if (out && out.type) await drive(app, [out])
    }
  }
  return app
}

const resize = { type: 'resize', width: 100, height: 30 }
const keyMsg = (name) => ({ type: 'key', name, toString: () => name })
const screen = (app) => style.stripAnsi(app.view())

const COLLISION = {
  collisionId: 'c1',
  tier: 'PREDICTED',
  symbols: ['src/types/user.ts#User.id:property'],
  writerSession: 'backend',
  affectedSessions: ['payments'],
  detail: 'backend is changing User.id; payments has already read it.',
  status: 'open'
}

const STATE = {
  roomId: 'hackathon',
  mode: 'authority',
  sessionId: 'backend',
  agents: [
    {
      sessionId: 'backend',
      host: 'claude-code',
      status: 'active',
      intent: { task: 'Change User.id to a UUID', files: [], symbols: [] }
    },
    { sessionId: 'payments', host: 'codex', status: 'active' }
  ],
  leases: [],
  collisions: [COLLISION],
  // Derived by the daemon from the event stream: who has done something lately.
  activity: { backend: { what: 'editing user.ts', sinceMs: 1200 } },
  summary: { sessions: 2, activeSessions: 2, openCollisions: 1, activeLeases: 0 }
}

const loaded = { type: 'qvac.loaded', model: 'LLAMA_3_2_1B_INST_Q4_0' }

// ── the negotiator ──────────────────────────────────────────────────────────

test('parses symbol keys into a readable name', (t) => {
  t.alike(parseSymbolKey('src/types/user.ts#User.id:property'), {
    file: 'src/types/user.ts',
    name: 'User.id',
    kind: 'property'
  })
  t.is(parseSymbolKey('nonsense').name, 'nonsense', 'a malformed key is not a crash')
})

test('prompts carry the facts the model needs and nothing else', (t) => {
  const explain = explainPrompt(COLLISION, STATE)
  t.is(explain.length, 2)
  t.ok(explain[1].content.includes('User.id'), 'names the shared symbol')
  t.ok(explain[1].content.includes('Change User.id to a UUID'), 'carries the writer task')
  t.ok(explain[1].content.includes('codex'), 'says which host the peer runs')

  const draft = contractPrompt(COLLISION, STATE)
  t.ok(draft[0].content.includes('JSON'), 'asks for JSON')
  t.ok(draft[1].content.includes('User.id'), 'names the symbol to draft for')
})

test('the explanation prompt is handed the contract it must put into words', (t) => {
  const contract = { symbol: 'User.id', before: 'number', after: 'string (UUID v4)' }
  const explain = explainPrompt(COLLISION, STATE, contract)
  t.ok(explain[1].content.includes('number to string (UUID v4)'), 'carries the change')
})

test('a period inside a symbol name does not end the sentence', (t) => {
  const withSymbol = 'User.id changes from number to a UUID string. Payments must adapt. Extra.'
  t.is(
    tidyExplanation(withSymbol, COLLISION),
    'User.id changes from number to a UUID string. Payments must adapt.'
  )
})

test('the tokenizer spaced symbol names are repaired', (t) => {
  t.ok(
    tidyExplanation('The writer is changing User. id in the backend.', COLLISION).includes(
      'User.id'
    ),
    'User. id becomes User.id'
  )
})

test('extracts a contract from fenced, prefixed or trailing-comma JSON', (t) => {
  const good = '{"symbol":"User.id","kind":"type","before":"number","after":"string (UUID)"}'
  t.is(parseContract(good, COLLISION).contract.after, 'string (UUID)')
  t.ok(parseContract(good, COLLISION).generated)

  const fenced = 'Here is the contract:\n```json\n' + good + '\n```\nHope that helps!'
  t.is(parseContract(fenced, COLLISION).contract.symbol, 'User.id', 'ignores prose and fences')

  const trailing = '{"symbol":"User.id","kind":"type","before":"number","after":"string",}'
  t.ok(parseContract(trailing, COLLISION).generated, 'repairs a trailing comma')
})

test('falls back rather than throwing on unusable output', (t) => {
  for (const bad of ['', 'I cannot help with that', '{"symbol":"User.id"}', '{oh no']) {
    const { contract, generated } = parseContract(bad, COLLISION)
    t.absent(generated, `not generated: ${JSON.stringify(bad)}`)
    t.is(contract.symbol, 'User.id', 'fallback still names the real symbol')
    t.ok(contract.constraint.includes('payments'), 'fallback names who must adopt')
  }
})

test('an unknown kind is coerced, not rejected', (t) => {
  const odd = '{"symbol":"User.id","kind":"interface","before":"a","after":"b"}'
  t.is(parseContract(odd, COLLISION).contract.kind, 'type')
})

test('explanations are clipped to two sentences', (t) => {
  const long = 'One. Two. Three. Four.'
  t.is(tidyExplanation(long, COLLISION), 'One. Two.')
  t.is(tidyExplanation('', COLLISION), COLLISION.detail, 'empty falls back to the detail')
})

test('explanations shed a role-play speaker label', (t) => {
  t.is(tidyExplanation('Claude: Payments must adapt.', COLLISION), 'Payments must adapt.')
  t.is(
    tidyExplanation('The rule is this: payments must adapt.', COLLISION),
    'The rule is this: payments must adapt.',
    'a colon inside a sentence is left alone'
  )
})

test('explanations shed the quotation marks small models add', (t) => {
  t.is(tidyExplanation('"Payments will break."', COLLISION), 'Payments will break.')
  t.is(tidyExplanation('"Payments will break.', COLLISION), 'Payments will break.', 'unbalanced')
  t.is(tidyExplanation('Payments will break.', COLLISION), 'Payments will break.', 'untouched')
})

test('a filler constraint is replaced, since "none" inverts the meaning', (t) => {
  const filler =
    '{"symbol":"User.id","kind":"type","before":"number","after":"string","constraint":"none"}'
  const { contract, generated } = parseContract(filler, COLLISION)
  t.ok(generated, 'the rest of the contract is still the model generated')
  t.ok(contract.constraint.includes('payments'), 'but the constraint is the deterministic one')
})

// ── the room view ───────────────────────────────────────────────────────────

test('shows the room before the model has loaded', async (t) => {
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'qvac.progress', percentage: 42 },
    { type: 'room.status', status: 'connected' },
    { type: 'room.state', state: { ...STATE, collisions: [] } }
  ])

  const view = screen(app)
  t.is(app.phase, 'loading')
  t.ok(view.includes('42%'), 'header reports download progress')
  t.ok(view.includes('Backend'), 'agent names use display capitalization')
  t.ok(view.includes('claude-code') && view.includes('codex'), 'each agent shows its host')
  t.ok(view.includes('editing user.ts'), 'a working agent shows what it is doing')
  t.ok(view.includes('idle'), 'one that has gone quiet says idle')
})

test('a peer never shows or accepts local model state', async (t) => {
  const inference = fakeInference()
  const peerState = { ...STATE, mode: 'peer' }
  let app = await drive(new App({ inference, room: fakeRoom() }), [
    resize,
    { type: 'room.status', status: 'connected' },
    { type: 'room.state', state: peerState },
    { type: 'qvac.progress', percentage: 75 },
    loaded
  ])
  const view = screen(app)
  t.is(app.phase, 'disabled')
  t.absent(view.includes('LLAMA'), 'peer header has no model name')
  t.absent(view.includes('loading 75%'), 'peer header has no model progress')
  t.absent(view.includes('loaded on this machine'), 'peer feed has no model notice')
  t.absent(view.includes('[r] redraft'), 'peer cannot invoke the local model')
  t.ok(view.includes('peer') && view.includes('Daemon ✓'), 'room role and daemon remain visible')
  app = await drive(app, [keyMsg('r')])
  t.is(inference.calls.asked.length, 0, 'peer redraft input never reaches inference')
})

test('an agent stops advertising a task once it goes quiet', async (t) => {
  const working = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: STATE }
  ])
  t.ok(screen(working).includes('editing user.ts'), 'busy: shows the live activity')

  // Same room, but the daemon no longer reports anyone as active.
  const quiet = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: { ...STATE, activity: {} } }
  ])
  const view = screen(quiet)
  t.absent(view.includes('editing user.ts'), 'quiet: the activity is gone')
  t.absent(
    view.includes('Change User.id to a UUID'),
    'and the announced task is not shown as if it were still happening'
  )
})

test('leave and same-session rejoin update the roster and feed immediately', async (t) => {
  const withoutPayments = {
    ...STATE,
    agents: STATE.agents.filter((agent) => agent.sessionId !== 'payments'),
    presence: { backend: 'live', payments: 'ended' },
    summary: { ...STATE.summary, activeSessions: 1 }
  }
  const rejoined = {
    ...STATE,
    presence: { backend: 'live', payments: 'live' }
  }
  let app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: STATE },
    {
      type: 'room.event',
      frame: { seq: 8, eventType: 'SESSION_ENDED', text: '#8 payments left the room' }
    },
    { type: 'room.state', state: withoutPayments }
  ])
  t.ok(screen(app).includes('Payments left the room'), 'departure is visible in the live feed')
  t.absent(
    app.state.agents.some((agent) => agent.sessionId === 'payments'),
    'departure removes the roster row'
  )

  app = await drive(app, [
    {
      type: 'room.event',
      frame: { seq: 9, eventType: 'SESSION_STARTED', text: '#9 payments joined the room' }
    },
    { type: 'room.state', state: rejoined }
  ])

  const view = screen(app)
  t.ok(view.includes('Payments joined the room'), 'same-id rejoin is visible in the live feed')
  t.ok(
    app.state.agents.some((agent) => agent.sessionId === 'payments'),
    'rejoin restores the row'
  )
  t.ok(view.includes('2/2 online'), 'footer uses current live presence')
})

test('a collision arriving after load is explained, then drafted, then sendable', async (t) => {
  const inference = fakeInference()
  const room = fakeRoom()
  let app = await drive(new App({ inference, room }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE }
  ])

  t.is(app.current.collision.collisionId, 'c1', 'the collision is on the panel')
  t.is(app.current.phase, 'drafting', 'the contract is drafted first')
  t.is(inference.calls.asked.length, 1, 'asked for a contract')
  t.ok(inference.calls.formats[0], 'the contract call is grammar-constrained')
  t.is(inference.calls.formats[0].type, 'json_schema')

  app = await drive(app, [
    {
      type: 'qvac.delta',
      id: 1,
      text: '{"symbol":"User.id","kind":"type","before":"number","after":"string (UUID v4)","constraint":"treat it as opaque"}'
    },
    { type: 'qvac.end', id: 1 }
  ])

  t.is(app.current.phase, 'explaining')
  t.is(inference.calls.asked.length, 2, 'asked it to put the contract into words')
  t.is(inference.calls.formats[1], null, 'prose is unconstrained')
  t.ok(
    inference.calls.asked[1][1].content.includes('number to string (UUID v4)'),
    'and the explanation call was handed the drafted contract'
  )

  app = await drive(app, [
    { type: 'qvac.delta', id: 2, text: 'User.id becomes a UUID string. Payments must adapt.' },
    { type: 'qvac.end', id: 2 }
  ])

  t.is(app.current.phase, 'ready')
  t.ok(app.current.generated, 'the contract came from the model')
  const view = screen(app)
  t.ok(view.includes('PREDICTED'), 'the tier is on screen')
  t.ok(view.includes('number → string (UUID v4)'), 'the contract is on screen')
  t.ok(view.includes('[enter] send proposal'), 'and it is waiting for a human')
})

test('nothing leaves this laptop until a key is pressed', async (t) => {
  const inference = fakeInference()
  const room = fakeRoom()
  let app = await drive(new App({ inference, room }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE },
    {
      type: 'qvac.delta',
      id: 1,
      text: '{"symbol":"User.id","kind":"type","before":"number","after":"string"}'
    },
    { type: 'qvac.end', id: 1 },
    { type: 'qvac.delta', id: 2, text: 'It will break.' },
    { type: 'qvac.end', id: 2 }
  ])

  t.is(room.calls.proposed.length, 0, 'a drafted contract is not sent on its own')

  app = await drive(app, [keyMsg('enter')])

  t.is(room.calls.proposed.length, 1, 'enter sends it')
  t.is(room.calls.proposed[0].collisionId, 'c1')
  t.is(room.calls.proposed[0].contract.after, 'string')
  t.is(room.calls.narrated.length, 1, 'the explanation goes out as dashboard-only dialogue')
  t.is(app.current, null, 'the panel clears for the next collision')
})

test('dismiss drops the collision without sending anything', async (t) => {
  const room = fakeRoom()
  let app = await drive(new App({ inference: fakeInference(), room }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE }
  ])
  app = await drive(app, [keyMsg('x')])

  t.is(room.calls.proposed.length, 0)
  t.is(app.current, null)
})

test('a failed send keeps the panel so it can be retried', async (t) => {
  const room = fakeRoom({ fail: true })
  let app = await drive(new App({ inference: fakeInference(), room }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE },
    {
      type: 'qvac.delta',
      id: 1,
      text: '{"symbol":"User.id","kind":"type","before":"a","after":"b"}'
    },
    { type: 'qvac.end', id: 1 },
    { type: 'qvac.delta', id: 2, text: 'It will break.' },
    { type: 'qvac.end', id: 2 }
  ])
  app = await drive(app, [keyMsg('enter')])

  t.is(app.current.phase, 'ready', 'still on screen')
  t.ok(screen(app).includes('could not send'), 'and the failure is reported')
})

test('a laptop whose model never loaded still shows and can send a collision', async (t) => {
  const room = fakeRoom()
  let app = await drive(new App({ inference: fakeInference(), room }), [
    resize,
    { type: 'qvac.error', message: 'no GPU and no CPU backend' },
    { type: 'room.state', state: STATE }
  ])

  t.is(app.phase, 'failed')
  t.is(app.current.phase, 'ready', 'the panel is usable without a model')
  t.absent(app.current.generated, 'marked as a deterministic draft')
  t.ok(screen(app).includes('deterministic draft'), 'and says so on screen')
  t.ok(screen(app).includes('User.id'), 'the real symbol is still named')

  app = await drive(app, [keyMsg('enter')])
  t.is(room.calls.proposed.length, 1, 'it can still negotiate')
})

test('a model failure mid-draft degrades instead of hanging', async (t) => {
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE },
    { type: 'qvac.error', id: 1, message: 'context overflow' }
  ])

  t.is(app.current.phase, 'ready')
  t.alike(app.current.contract, fallbackContract(COLLISION))
  t.is(app.current.explanation, COLLISION.detail, 'and says what detection already knew')
})

test('a failure after the contract keeps the contract', async (t) => {
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE },
    {
      type: 'qvac.delta',
      id: 1,
      text: '{"symbol":"User.id","kind":"type","before":"number","after":"string (UUID v4)"}'
    },
    { type: 'qvac.end', id: 1 },
    { type: 'qvac.error', id: 2, message: 'context overflow' }
  ])

  t.is(app.current.phase, 'ready')
  t.is(app.current.contract.after, 'string (UUID v4)', 'the drafted contract survives')
})

test('collisions queue one at a time and the same one is never re-queued', async (t) => {
  const second = { ...COLLISION, collisionId: 'c2', affectedSessions: ['frontend'] }
  let app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE },
    { type: 'room.state', state: { ...STATE, collisions: [COLLISION, second] } },
    { type: 'room.state', state: { ...STATE, collisions: [COLLISION, second] } }
  ])

  t.is(app.current.collision.collisionId, 'c1', 'the first one holds the panel')
  t.is(app.queue.length, 1, 'the second waits, and repeats are ignored')

  app = await drive(app, [keyMsg('x')])
  t.is(app.current.collision.collisionId, 'c2', 'dismissing advances to it')
})

test('the room feed records events and never grows without bound', async (t) => {
  const events = []
  for (let i = 0; i < 500; i++) {
    events.push({
      type: 'room.event',
      frame: { seq: i, eventType: 'FILE_READ', text: `read ${i}` }
    })
  }
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    ...events
  ])
  t.ok(app.feed.length <= 400, 'the feed is capped')
  t.ok(screen(app).includes('read 499'), 'and shows the newest line')
})

test('the room feed shows agent actions without tags, sequence numbers, or heartbeats', async (t) => {
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    {
      type: 'room.event',
      frame: { seq: 78, eventType: 'FILE_READ', text: '#78 vibecode FILE_READ spec.md' }
    },
    {
      type: 'room.event',
      frame: { seq: 80, eventType: 'HEARTBEAT', text: '#80 backend HEARTBEAT' }
    }
  ])
  const view = screen(app)
  t.is(app.feed.length, 1, 'heartbeat is not retained in the feed')
  t.ok(view.includes('Vibecode FILE_READ spec.md'), 'agent and action remain')
  t.absent(view.includes('FILE·REA'), 'abbreviated event tag is removed')
  t.absent(view.includes('#78'), 'sequence number is removed')
  t.absent(view.includes('HEARTBEAT'), 'heartbeat is hidden')
})

test('agent capitalization is consistent across roster and mixed-case feed events', async (t) => {
  const state = {
    ...STATE,
    agents: [{ sessionId: 'vishnu', host: 'codex', status: 'active' }]
  }
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.status', status: 'connected' },
    { type: 'room.state', state },
    {
      type: 'room.event',
      frame: { seq: 81, eventType: 'TOOL_CALL', text: '#81 Vishnu TOOL_CALL Bash' }
    },
    {
      type: 'room.event',
      frame: { seq: 82, eventType: 'FILE_WRITE', text: '#82 vishnu FILE_WRITE README.md' }
    }
  ])
  const view = screen(app)

  t.ok(/Vishnu\s+codex/.test(view), 'roster capitalizes the session name')
  t.ok(view.includes('Vishnu TOOL_CALL Bash'), 'already-capitalized feed names stay intact')
  t.ok(view.includes('Vishnu FILE_WRITE README.md'), 'lowercase feed names match the roster')
  t.ok(view.includes('Daemon ✓'), 'connected daemon status uses display capitalization')
  t.absent(view.includes('vishnu FILE_WRITE'), 'lowercase display variant is removed')
})

test('the view never exceeds the terminal height', async (t) => {
  for (const height of [12, 24, 30, 60]) {
    const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
      { type: 'resize', width: 100, height },
      loaded,
      { type: 'room.state', state: STATE }
    ])
    const rows = screen(app).split('\n')
    t.ok(rows.length <= height, `${rows.length} rows fits in ${height}`)
    for (const row of rows) {
      t.ok(style.stripAnsi(row).length <= 100, 'no row overflows the width')
    }
  }
})

// ── Part 3: speech controls ──────────────────────────────────────────────────

test('agent rows show speech buttons instead of circle indicators', async (t) => {
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: { ...STATE, collisions: [] } }
  ])
  const view = screen(app)
  // No old-style circle dots.
  t.absent(view.includes('●'), 'no filled circle')
  t.absent(view.includes('◐'), 'no half circle')
  t.absent(view.includes('○'), 'no empty circle')
  // Speech buttons are present.
  t.ok(view.includes('[♪]') || view.includes('[×]'), 'speech button present')
})

test('local agent starts available (▶), remote agents start muted (×)', async (t) => {
  const speech = fakeSpeech()
  const app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech, localSession: 'backend' }),
    [resize, { type: 'room.state', state: { ...STATE, collisions: [] } }]
  )
  const view = screen(app)
  // backend is local -> available [▶]
  t.ok(view.includes('[▶]'), 'local agent shows available button')
  // payments is remote -> muted [×]
  t.ok(view.includes('[×]'), 'remote agent shows muted button')
})

test('local session is seeded from room.state.sessionId when not provided', async (t) => {
  const app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech: fakeSpeech() }),
    [resize, { type: 'room.state', state: { ...STATE, sessionId: 'backend', collisions: [] } }]
  )
  t.is(app.localSession, 'backend', 'local session set from state')
  // backend row should be enabled
  t.ok(screen(app).includes('[▶]'), 'local agent shows available button')
})

test('speech.started marks the speaking session and only that row shows [♪]', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.started', sessionId: 'backend' }
    ]
  )
  const view = screen(app)
  t.ok(view.includes('[♪]'), 'speaking session shows speech button')
  t.is(app.speakingSession, 'backend')
})

test('speech.finished clears the speaking state', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.started', sessionId: 'backend' },
      { type: 'speech.finished', sessionId: 'backend' }
    ]
  )
  t.is(app.speakingSession, null)
  // Back to idle enabled state for local agent
  t.ok(screen(app).includes('[▶]'), 'back to available idle after finished')
})

test('speech.finished for a different session does not clear the active speaker', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.started', sessionId: 'backend' },
      { type: 'speech.finished', sessionId: 'payments' }
    ]
  )
  t.is(app.speakingSession, 'backend', 'speaking session unchanged for unrelated finish')
})

test('speaking a session never highlights a different row', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.started', sessionId: 'payments' }
    ]
  )
  t.is(app.speakingSession, 'payments')
  // The view should show [♪] for payments and no other row.
  const plain = screen(app)
  const playCount = (plain.match(/\[♪\]/g) || []).length
  t.is(playCount, 1, 'exactly one row shows playing')
})

test('the speaker is named while the line is still being synthesised', async (t) => {
  // Synthesis takes seconds. Waiting for playback to name the speaker means
  // naming them once they are already talking.
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.queue', speaking: null, preparing: 'payments', pending: ['backend'] }
    ]
  )
  const view = screen(app)
  t.ok(view.includes('Payments next'), 'the footer names the speaker before any audio')
  t.absent(view.includes('speaking'), 'and does not claim they are speaking yet')
  t.absent(view.includes('[♪]'), 'no row claims to be playing')
})

test('the footer names who is speaking, including the room itself', async (t) => {
  let app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.queue', speaking: 'payments', preparing: null, pending: [] }
    ]
  )
  t.ok(screen(app).includes('Payments speaking'), 'the active speaker is named')

  // The orchestrator's own lines belong to no agent row, so the footer is the
  // only place they can be attributed.
  app = await drive(app, [
    { type: 'speech.queue', speaking: 'agentigram', preparing: null, pending: [] }
  ])
  t.ok(screen(app).includes('Agentigram speaking'), 'a line from the room is attributed too')

  app = await drive(app, [{ type: 'speech.queue', speaking: null, preparing: null, pending: [] }])
  t.absent(screen(app).includes('speaking'), 'silence names nobody')
})

test('a queued agent row moves before its audio starts', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.queue', speaking: null, preparing: 'backend', pending: [] }
    ]
  )
  const view = screen(app)
  t.absent(view.includes('[▶]'), 'the row no longer reads as idle')
  t.absent(view.includes('[♪]'), 'and does not yet read as playing')
  t.is(app.preparingSession, 'backend')
})

test('the authority defaults to voicing agents that are not here to speak', async (t) => {
  // No controller injected, so the view falls back to its own default: on the
  // authority, which is where the orchestrator negotiates for absent agents.
  const authority = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: { ...STATE, mode: 'authority', collisions: [] } }
  ])
  t.absent(authority._isMuted('payments'), 'the authority voices a remote agent')

  const peer = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: { ...STATE, mode: 'peer', collisions: [] } }
  ])
  t.ok(peer._isMuted('payments'), 'a peer does not repeat it')
  t.absent(peer._isMuted('agentigram'), 'but every laptop hears the room itself')
})

test('speech.error marks speech unavailable and shows [!]', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.error', message: 'model failed to load' }
    ]
  )
  t.is(app.speechErrors.size, 2, 'speech marked unavailable for both agents')
  const view = screen(app)
  t.ok(view.includes('[!]'), 'unavailable button shown')
  t.absent(view.includes('[▶]'), 'no available button when unavailable')
  t.absent(view.includes('[×]'), 'no muted button when unavailable')
  t.ok(view.includes('speech error'), 'error note added to feed')
})

test('speech.muted syncs the mute map', async (t) => {
  const app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), localSession: 'backend' }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.muted', sessionId: 'backend', muted: true }
    ]
  )
  t.is(app.speechMuted.get('backend'), true, 'backend muted via event')
})

test('s key toggles speech for the selected agent and calls speech.mute', async (t) => {
  const speech = fakeSpeech()
  let app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech, localSession: 'backend' }),
    [resize, { type: 'room.state', state: { ...STATE, collisions: [] } }]
  )
  // selectedAgent = 0 = 'backend', which starts enabled (unmuted).
  app = await drive(app, [keyMsg('s')])
  // Should now be muted.
  t.ok(app.speechMuted.get('backend'), 'backend muted after s key')
  t.is(speech.calls.muted.length, 1, 'speech.mute called')
  t.is(speech.calls.muted[0].sessionId, 'backend')
  t.is(speech.calls.muted[0].muted, true)
})

test('s key toggles back from muted to enabled', async (t) => {
  const speech = fakeSpeech()
  let app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech, localSession: 'backend' }),
    [resize, { type: 'room.state', state: { ...STATE, collisions: [] } }]
  )
  // Toggle once (enable->mute), twice (mute->enable).
  app = await drive(app, [keyMsg('s'), keyMsg('s')])
  t.is(app.speechMuted.get('backend'), false, 'backend re-enabled after second toggle')
  t.is(speech.calls.muted.length, 2)
  t.is(speech.calls.muted[1].muted, false)
})

test('arrow keys change the selected agent', async (t) => {
  let app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: { ...STATE, collisions: [] } }
  ])
  t.is(app.selectedAgent, 0, 'starts on first agent')

  app = await drive(app, [keyMsg('down')])
  t.is(app.selectedAgent, 1, 'down moves to second agent')

  app = await drive(app, [keyMsg('down')])
  t.is(app.selectedAgent, 1, 'does not go past last agent')

  app = await drive(app, [keyMsg('up')])
  t.is(app.selectedAgent, 0, 'up goes back to first')

  app = await drive(app, [keyMsg('up')])
  t.is(app.selectedAgent, 0, 'does not go past first agent')
})

test('s on a remote agent (arrow-selected) toggles its mute state', async (t) => {
  const speech = fakeSpeech()
  let app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech, localSession: 'backend' }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      keyMsg('down') // select payments (index 1)
    ]
  )
  t.is(app.selectedAgent, 1)
  // payments starts muted (remote); toggling should unmute it.
  app = await drive(app, [keyMsg('s')])
  t.is(app.speechMuted.get('payments'), false, 'payments unmuted')
  t.is(speech.calls.muted[0].sessionId, 'payments')
  t.is(speech.calls.muted[0].muted, false)
})

test('mouse click on speech button hitbox toggles that session', async (t) => {
  const speech = fakeSpeech()
  let app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech, localSession: 'backend' }),
    [resize, { type: 'room.state', state: { ...STATE, collisions: [] } }]
  )
  // Force a view render to populate hitboxes.
  app.view()
  const hitbox = app._speechHitboxes.find((h) => h.sessionId === 'backend')
  t.ok(hitbox, 'hitbox registered for backend')

  app = await drive(app, [
    { type: 'mouse', action: 'click', x: hitbox.col, y: hitbox.row, button: 'left' }
  ])
  t.ok(app.speechMuted.get('backend'), 'backend muted after click')
  t.is(speech.calls.muted.length, 1)
})

test('mouse click outside hitboxes does not toggle anything', async (t) => {
  const speech = fakeSpeech()
  let app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), speech, localSession: 'backend' }),
    [resize, { type: 'room.state', state: { ...STATE, collisions: [] } }]
  )
  app.view()
  app = await drive(app, [{ type: 'mouse', action: 'click', x: 0, y: 0, button: 'left' }])
  t.is(speech.calls.muted.length, 0, 'no toggle on miss')
})

test('speech error does not interrupt messaging or negotiation', async (t) => {
  const room = fakeRoom()
  let app = await drive(new App({ inference: fakeInference(), room }), [
    resize,
    loaded,
    { type: 'room.state', state: STATE },
    { type: 'speech.error', message: 'afplay not found' }
  ])
  // Collision panel should still work.
  t.ok(app.current, 'collision panel unaffected')
  app = await drive(app, [keyMsg('x')])
  t.is(app.current, null, 'can still dismiss')
})

test('footer shows [s] voice hint', async (t) => {
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    { type: 'room.state', state: { ...STATE, collisions: [] } }
  ])
  t.ok(screen(app).includes('[s] voice'), 'footer has speech hint')
})

test('view height and width are preserved with speech controls', async (t) => {
  // Width must be >= 80 to avoid the pre-existing header overflow at very
  // narrow terminals (same constraint as the original view height test which
  // used width=100). The purpose here is to confirm speech controls add no
  // extra rows and do not themselves overflow the terminal.
  for (const [width, height] of [
    [80, 12],
    [100, 20],
    [100, 30],
    [200, 60]
  ]) {
    const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
      { type: 'resize', width, height },
      loaded,
      { type: 'room.state', state: STATE }
    ])
    const rows = screen(app).split('\n')
    t.ok(rows.length <= height, `${rows.length} rows fits in ${height}`)
    for (const row of rows) {
      t.ok(style.stripAnsi(row).length <= width, `row fits in ${width}`)
    }
  }
})

test('speech button is preserved at narrow widths while host text truncates', async (t) => {
  const app = await drive(
    new App({ inference: fakeInference(), room: fakeRoom(), localSession: 'backend' }),
    [
      { type: 'resize', width: 40, height: 24 },
      { type: 'room.state', state: { ...STATE, collisions: [] } }
    ]
  )
  const view = screen(app)
  // At 40 columns, the speech button should still appear.
  t.ok(
    view.includes('[♪]') || view.includes('[×]') || view.includes('[!]'),
    'button preserved at 40 cols'
  )
})

test('speech.ready clears speech errors', async (t) => {
  const app = await drive(
    new App({
      inference: fakeInference(),
      room: fakeRoom(),
      speech: fakeSpeech(),
      localSession: 'backend'
    }),
    [
      resize,
      { type: 'room.state', state: { ...STATE, collisions: [] } },
      { type: 'speech.error', message: 'init failed' },
      { type: 'speech.ready' }
    ]
  )
  t.is(app.speechErrors.size, 0, 'unavailable cleared by speech.ready')
})
