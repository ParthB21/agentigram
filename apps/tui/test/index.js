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

test('the tokenizer’s spaced symbol names are repaired', (t) => {
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
  t.ok(generated, 'the rest of the contract is still the model’s')
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
  t.ok(view.includes('backend'), 'agents are listed')
  t.ok(view.includes('claude-code') && view.includes('codex'), 'each agent shows its host')
  t.ok(view.includes('Change User.id to a UUID'), 'shows what each agent is doing')
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
    { type: 'qvac.delta', id: 1, text: '{"symbol":"User.id","kind":"type","before":"a","after":"b"}' },
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
    events.push({ type: 'room.event', frame: { seq: i, eventType: 'FILE_READ', text: `read ${i}` } })
  }
  const app = await drive(new App({ inference: fakeInference(), room: fakeRoom() }), [
    resize,
    ...events
  ])
  t.ok(app.feed.length <= 400, 'the feed is capped')
  t.ok(screen(app).includes('read 499'), 'and shows the newest line')
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
