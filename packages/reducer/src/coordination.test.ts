import { type Event, emptyRoomState, type Payload, symbolKey } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { reduce } from './reduce.js';
import { routeEvent } from './routing.js';

const userId = symbolKey('src/types/user.ts', 'User', 'id', 'property');

function event(seq: number, payload: Payload, sessionId = 'backend', minutes = 0): Event {
  return {
    id: `event-${seq}`,
    seq,
    roomId: 'room',
    ts: new Date(Date.UTC(2026, 8, 19, 12, minutes, seq)).toISOString(),
    actor: { engineerId: sessionId, sessionId, kind: 'agent' },
    source: 'system',
    payload,
  };
}

function started(state = emptyRoomState('room')) {
  let next = reduce(
    state,
    event(1, {
      type: 'SESSION_STARTED',
      sessionId: 'backend',
      host: 'claude-code',
      model: 'claude',
      branch: 'main',
    }),
  ).state;
  next = reduce(
    next,
    event(
      2,
      {
        type: 'SESSION_STARTED',
        sessionId: 'payments',
        host: 'codex',
        model: 'gpt',
        branch: 'main',
      },
      'payments',
    ),
  ).state;
  return next;
}

const contract = {
  symbol: 'src/types/user.ts#User.id',
  kind: 'type' as const,
  before: 'number',
  after: 'string',
  constraint: 'UUID v4',
};

describe('coordination reducer', () => {
  it('opens a deterministic file-overlap collision and negotiation', () => {
    let state = started();
    state = reduce(
      state,
      event(
        3,
        { type: 'INTENT', task: 'checkout', files: ['src/types/user.ts'], symbols: [userId] },
        'payments',
      ),
    ).state;
    state = reduce(
      state,
      event(4, { type: 'FILE_WRITE', path: 'src/types/user.ts', worktree: '/repo' }),
    ).state;
    expect(state.collisions['file-overlap:4']).toMatchObject({
      tier: 'FILE_OVERLAP',
      affectedSessions: ['payments'],
    });
    expect(state.negotiations['file-overlap:4']?.participants).toEqual(['backend', 'payments']);
  });

  it('negotiates, requests compilation, compiles, and verifies a contract', () => {
    let state = started();
    state = reduce(
      state,
      event(3, {
        type: 'COLLISION',
        collisionId: 'collision',
        tier: 'SEMANTIC',
        symbols: [userId],
        writerSession: 'backend',
        affectedSessions: ['payments'],
        detail: 'id type changed',
      }),
    ).state;
    state = reduce(state, event(4, { type: 'PROPOSAL', collisionId: 'collision', contract })).state;
    state = reduce(state, event(5, { type: 'ACCEPT', collisionId: 'collision' })).state;
    const accepted = reduce(
      state,
      event(6, { type: 'ACCEPT', collisionId: 'collision' }, 'payments'),
    );
    expect(accepted.state.negotiations.collision?.state).toBe('Accepted');
    expect(accepted.effects).toContainEqual({
      kind: 'request_contract_compile',
      collisionId: 'collision',
      contract,
    });
    state = reduce(
      accepted.state,
      event(7, {
        type: 'CONTRACT_COMPILED',
        contractId: 'contract-1',
        collisionId: 'collision',
        checkFiles: [],
      }),
    ).state;
    state = reduce(
      state,
      event(8, {
        type: 'SPEC_MERGE_RESULT',
        baseCommit: 'abc',
        sessions: ['backend', 'payments'],
        typeErrors: [],
        failingTests: [],
        notRun: [],
      }),
    ).state;
    expect(state.negotiations.collision?.state).toBe('Verified');
    expect(state.collisions.collision?.status).toBe('resolved');
    expect(state.contracts['contract-1']?.status).toBe('verified');
  });

  it('escalates after three counter rounds and accepts only a human decision', () => {
    let state = started();
    state = reduce(
      state,
      event(3, {
        type: 'COLLISION',
        collisionId: 'collision',
        tier: 'PREDICTED',
        symbols: [userId],
        writerSession: 'backend',
        affectedSessions: ['payments'],
        detail: 'possible break',
      }),
    ).state;
    state = reduce(state, event(4, { type: 'PROPOSAL', collisionId: 'collision', contract })).state;
    for (let seq = 5; seq <= 7; seq += 1) {
      state = reduce(
        state,
        event(
          seq,
          { type: 'COUNTER', collisionId: 'collision', contract, reason: 'revise' },
          'payments',
        ),
      ).state;
    }
    expect(state.negotiations.collision?.state).toBe('Escalated');
    state = reduce(state, event(8, { type: 'ACCEPT', collisionId: 'collision' }, 'payments')).state;
    expect(state.negotiations.collision?.state).toBe('Escalated');
    const human = event(9, { type: 'ACCEPT', collisionId: 'collision' });
    human.actor = { engineerId: 'owner', kind: 'human' };
    state = reduce(state, human).state;
    expect(state.negotiations.collision?.state).toBe('Accepted');
  });

  it('renews owned leases on heartbeat and releases them when the session ends', () => {
    let state = started();
    state = reduce(
      state,
      event(3, {
        type: 'LEASE_GRANTED',
        leaseId: 'lease',
        sessionId: 'backend',
        symbols: [userId],
        fencingToken: 2,
        expiresAt: '2026-09-19T12:05:00.000Z',
        ttlMs: 600_000,
      }),
    ).state;
    state = reduce(
      state,
      event(4, { type: 'HEARTBEAT', sessionId: 'backend' }, 'backend', 4),
    ).state;
    expect(Date.parse(state.leases.lease?.expiresAt ?? '')).toBeGreaterThan(
      Date.parse('2026-09-19T12:05:00.000Z'),
    );
    state = reduce(state, event(5, { type: 'SESSION_ENDED', sessionId: 'backend' })).state;
    expect(state.leases.lease).toBeUndefined();
  });
});

describe('agent routing', () => {
  it('routes symbol events to affected read sets and never routes presentation or markets', () => {
    let state = started();
    state = reduce(
      state,
      event(3, { type: 'FILE_READ', path: 'src/types/user.ts', symbols: [userId] }, 'payments'),
    ).state;
    const collision = event(4, {
      type: 'COLLISION',
      collisionId: 'collision',
      tier: 'PREDICTED',
      symbols: [userId],
      writerSession: 'backend',
      affectedSessions: ['payments'],
      detail: 'possible break',
    });
    expect(routeEvent(state, collision)).toContain('payments');
    expect(
      routeEvent(
        state,
        event(5, { type: 'PERSONA_LINES', lines: [{ speaker: 'x', text: 'y', seq: 4 }] }),
      ),
    ).toEqual([]);
    expect(
      routeEvent(
        state,
        event(6, {
          type: 'MARKET_OPENED',
          marketId: 'm',
          kind: 'binary',
          question: 'q',
          outcomes: ['yes', 'no'],
          b: 10,
          closesAt: '2026-09-19T13:00:00.000Z',
        }),
      ),
    ).toEqual([]);
  });
});
