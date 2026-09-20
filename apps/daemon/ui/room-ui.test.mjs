import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deriveAgentView,
  displayName,
  initials,
  latestCollision,
  speakerForFrame,
  stableHue,
  symbolName,
} from './model.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};

class Utterance {
  constructor(text) {
    this.text = text;
  }
}

const synthesizer = {
  active: null,
  cancelled: 0,
  getVoices: () => [
    { name: 'Voice A', lang: 'en-US' },
    { name: 'Voice B', lang: 'en-GB' },
  ],
  speak(utterance) {
    this.active = utterance;
    queueMicrotask(() => utterance.onstart?.());
  },
  cancel() {
    this.cancelled += 1;
    this.active = null;
  },
};

globalThis.window = {
  SpeechSynthesisUtterance: Utterance,
  speechSynthesis: synthesizer,
  setTimeout,
  agentigram: { setVoiceSettings: async () => ({ enabled: true, volume: 0.8 }) },
};
globalThis.SpeechSynthesisUtterance = Utterance;

test('display helpers turn session ids into stable identities', () => {
  assert.equal(displayName('payments_agent'), 'Payments Agent');
  assert.equal(initials('payments_agent'), 'PA');
  assert.equal(initials('backend'), 'BA');
  assert.equal(stableHue('backend'), stableHue('backend'));
  assert.notEqual(stableHue('backend'), stableHue('payments'));
  assert.equal(symbolName('src/types/user.ts#User.id:property'), 'User.id');
});

test('latestCollision selects the newest unresolved collision', () => {
  const collision = latestCollision({
    collisions: [
      { collisionId: 'old', openedSeq: 2, status: 'resolved' },
      { collisionId: 'middle', openedSeq: 8, status: 'open' },
      { collisionId: 'new', openedSeq: 12, status: 'open' },
    ],
  });
  assert.equal(collision.collisionId, 'new');
});

test('deriveAgentView gives playback state precedence over work state', () => {
  const state = {
    presence: { backend: 'live' },
    activity: { backend: { what: 'editing user.ts', sinceMs: 20 } },
    leases: [{ leaseId: 'lease-1', sessionId: 'backend' }],
    collisions: [],
  };
  const agent = { sessionId: 'backend', host: 'codex', model: 'gpt-5' };
  const view = deriveAgentView(state, agent, 'speaking', false);
  assert.equal(view.label, 'Speaking');
  assert.equal(view.working, true);
  assert.equal(view.leases.length, 1);
});

test('deriveAgentView hides unknown model labels', () => {
  const view = deriveAgentView({ presence: { backend: 'live' }, collisions: [] }, {
    sessionId: 'backend',
    host: 'codex',
    model: 'unknown',
  });
  assert.equal(view.host, 'codex');

  const empty = deriveAgentView({ presence: { backend: 'live' }, collisions: [] }, {
    sessionId: 'backend',
    host: 'unknown',
    model: 'unknown',
  });
  assert.equal(empty.host, '');
});

test('speech attribution overrides the event actor for orchestrator narration', () => {
  assert.equal(
    speakerForFrame({ sessionId: 'backend', speech: { speaker: 'agentigram' } }),
    'agentigram',
  );
  assert.equal(speakerForFrame({ sessionId: 'backend' }), 'backend');
});

test('desktop negotiations are read-only with no human decision bridge', () => {
  const sources = ['index.html', 'renderer.js', 'preload.cjs', 'main.cjs']
    .map((name) => readFileSync(new URL(name, import.meta.url), 'utf8'))
    .join('\n');
  assert.doesNotMatch(sources, /Accept resolution|Escalate|submitHumanAction|human-action/);
  assert.match(sources, /negotiationStatus/);
});

test('speech queue deduplicates, tracks actual playback, and respects remote mute defaults', async () => {
  storage.clear();
  const { SpeechQueue } = await import('./speech.js');
  const states = [];
  const queue = new SpeechQueue({ onState: (event) => states.push(event) });
  queue.setLocalSession('backend');

  assert.equal(
    queue.enqueue({ seq: 1, speaker: 'payments', text: 'remote line', priority: 1 }),
    false,
  );
  assert.equal(
    queue.enqueue({ seq: 2, speaker: 'backend', text: 'local line', priority: 1 }),
    true,
  );
  assert.equal(
    queue.enqueue({ seq: 2, speaker: 'backend', text: 'duplicate', priority: 1 }),
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(states.some((event) => event.seq === 2 && event.state === 'synthesizing'));
  assert.ok(states.some((event) => event.seq === 2 && event.state === 'speaking'));
  synthesizer.active.onend();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(states.some((event) => event.seq === 2 && event.state === 'idle'));
});

test('authority voices the room while peers default to their local agent', async () => {
  storage.clear();
  const { SpeechQueue } = await import('./speech.js');
  const queue = new SpeechQueue();
  queue.setLocalSession('backend');
  assert.equal(queue.isMuted('payments'), true);
  assert.equal(queue.isMuted('agentigram'), false);
  queue.setVoiceAll(true);
  assert.equal(queue.isMuted('payments'), false);
});

test('urgent speech interrupts routine playback', async () => {
  storage.clear();
  const { SpeechQueue } = await import('./speech.js');
  const states = [];
  const queue = new SpeechQueue({ onState: (event) => states.push(event) });
  queue.setLocalSession('backend');
  queue.enqueue({ seq: 10, speaker: 'backend', text: 'routine', priority: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue({ seq: 11, speaker: 'backend', text: 'urgent', priority: 3 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(states.some((event) => event.seq === 10 && event.interrupted));
  assert.ok(states.some((event) => event.seq === 11 && event.state === 'speaking'));
});
