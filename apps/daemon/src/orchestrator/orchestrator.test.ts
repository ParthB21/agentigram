import {
  type CollisionState,
  type Event,
  emptyRoomState,
  type NewEvent,
  type Payload,
  type RoomState,
  symbolKey,
} from '@agentigram/protocol';
import { reduce } from '@agentigram/reducer';
import { describe, expect, it } from 'vitest';
import { freezeDenial } from './freeze.js';
import type { Llm } from './ollama.js';
import { Orchestrator } from './orchestrator.js';

const userId = symbolKey('src/types/user.ts', 'User', 'id', 'property');

function room() {
  let state = emptyRoomState('room');
  const log: Event[] = [];
  const apply = (input: NewEvent): number => {
    const seq = log.length + 1;
    const event: Event = {
      ...input,
      seq,
      ts: new Date(Date.UTC(2026, 8, 20, 12, 0, seq)).toISOString(),
    };
    log.push(event);
    state = reduce(state, event).state;
    return seq;
  };
  const submit = (payload: Payload, sessionId = 'backend') =>
    apply({
      id: `e${log.length + 1}`,
      roomId: 'room',
      actor: { engineerId: sessionId, sessionId, kind: 'agent' },
      source: 'hook',
      payload,
    });
  for (const [sessionId, host] of [
    ['backend', 'claude-code'],
    ['payments', 'codex'],
  ] as const) {
    submit({ type: 'SESSION_STARTED', sessionId, host, model: 'm', branch: 'main' }, sessionId);
  }
  submit({ type: 'INTENT', task: 'make User.id a UUID', files: [], symbols: [userId] });
  submit({ type: 'FILE_READ', path: 'src/types/user.ts', symbols: [userId] }, 'payments');
  submit({
    type: 'COLLISION',
    collisionId: 'c1',
    tier: 'PREDICTED',
    symbols: [userId],
    writerSession: 'backend',
    affectedSessions: ['payments'],
    detail: 'backend is changing User.id; payments has already read it.',
  });
  const host = {
    roomId: 'room',
    engineerId: 'eng',
    state: () => state,
    submit: async (event: NewEvent) => apply(event),
    log: { info: () => {}, warn: (o: object, m: string) => console.log(m, JSON.stringify(o)) },
  };
  return { host, log, state: () => state };
}

const options = { graceMs: 0, pace: async () => {} };

describe('freezeDenial', () => {
  it('freezes both parties on the contested file only while the negotiation is open', async () => {
    const r = room();
    const path = 'src/types/user.ts';
    expect(freezeDenial(r.state(), 'backend', path)).toMatch(/frozen/);
    expect(freezeDenial(r.state(), 'payments', path)).toMatch(/frozen/);
    expect(freezeDenial(r.state(), 'backend', 'src/other.ts')).toBeUndefined();
    // Not a party, but the file is in play between two others, so it is off limits to them too.
    expect(freezeDenial(r.state(), 'someone-else', path)).toMatch(/^STOP\./);

    const orchestrator = new Orchestrator(r.host, options);
    orchestrator.resume();
    await orchestrator.idle();
    expect(freezeDenial(r.state(), 'backend', path)).toBeUndefined();
    expect(freezeDenial(r.state(), 'payments', path)).toBeUndefined();
  });

  it('freezes on a file-overlap collision too: tier 0 is no longer advisory', () => {
    const r = room();
    const state: RoomState = {
      ...r.state(),
      collisions: {
        c1: { ...(r.state().collisions.c1 as CollisionState), tier: 'FILE_OVERLAP' },
      },
    };
    expect(freezeDenial(state, 'backend', 'src/types/user.ts')).toMatch(/^STOP\./);
  });
});

describe('Orchestrator', () => {
  it('debates a collision with no model, compiles the contract and tells both agents to resume', async () => {
    const r = room();
    const orchestrator = new Orchestrator(r.host, options);
    orchestrator.resume();
    await orchestrator.idle();

    const state = r.state();
    expect(state.negotiations.c1?.state).toBe('Compiled');
    expect(Object.values(state.contracts)).toHaveLength(1);

    const spoken = r.log.filter((e) => e.seq > 5);
    expect(spoken.every((e) => e.source === 'system')).toBe(true);
    const messages = spoken.flatMap((e) => (e.payload.type === 'MESSAGE' ? [e.payload] : []));
    // Debate turns must not wake a managed runner; only the final resume message does.
    const [last, ...debate] = [...messages].reverse();
    expect(last?.text).toMatch(/may resume/);
    expect(last?.automationDepth).toBe(0);
    expect(debate.length).toBeGreaterThan(0);
    expect(debate.every((m) => (m.automationDepth ?? 0) > 0)).toBe(true);
    // Both sides spoke.
    const speakers = new Set(spoken.map((e) => e.actor.sessionId).filter(Boolean));
    expect(speakers).toEqual(new Set(['backend', 'payments']));
  });

  it('debates a collision only once', async () => {
    const r = room();
    const orchestrator = new Orchestrator(r.host, options);
    orchestrator.resume();
    orchestrator.resume();
    orchestrator.handle(r.log.filter((e) => e.payload.type === 'COLLISION'));
    await orchestrator.idle();
    expect(r.log.filter((e) => e.payload.type === 'CONTRACT_COMPILED')).toHaveLength(1);
  });

  it('falls back to scripted turns when the model fails', async () => {
    const r = room();
    const llm: Llm = {
      json: async () => {
        throw new Error('ollama is down');
      },
    };
    const orchestrator = new Orchestrator(r.host, { ...options, llm });
    orchestrator.resume();
    await orchestrator.idle();
    expect(r.state().negotiations.c1?.state).toBe('Compiled');
  });

  it('merges a debate that never converges instead of escalating', async () => {
    const r = room();
    let n = 0;
    const llm: Llm = {
      // Always counters, so the round cap is reached and the orchestrator must synthesise.
      json: async ({ schema }) =>
        schema.parse(
          n++ === 0
            ? {
                message: 'Opening.',
                contract: { symbol: 'x', kind: 'type', before: 'a', after: 'b' },
              }
            : {
                stance: 'counter',
                message: `Counter ${n}.`,
                contract: { symbol: 'x', kind: 'type', before: 'a', after: `b${n}` },
              },
        ) as never,
    };
    const orchestrator = new Orchestrator(r.host, { ...options, llm });
    orchestrator.resume();
    await orchestrator.idle();
    expect(r.state().negotiations.c1?.state).toBe('Compiled');
  });
});
