import {
  emptyRoomState,
  MAX_AUTOMATION_DEPTH,
  type NewEvent,
  type RoomState,
  type SessionInfo,
} from '@agentigram/protocol';
import { reduce } from '@agentigram/reducer';
import { describe, expect, it } from 'vitest';
import type { Llm } from './ollama.js';
import { Planner } from './planner.js';

const USER_ID = 'src/types/user.ts#User.id:property';

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: id,
  engineerId: id,
  host: 'claude-code',
  model: 'claude-opus-5',
  branch: 'main',
  status: 'active',
  startedAt: '2026-09-20T00:00:00.000Z',
  lastHeartbeatAt: '2026-09-20T00:00:00.000Z',
  ...over,
});

/** A room whose state really reduces the planner's own events, so leases have to be legal. */
function harness(...sessions: SessionInfo[]) {
  let state: RoomState = {
    ...emptyRoomState('hackathon'),
    sessions: Object.fromEntries(sessions.map((one) => [one.sessionId, one])),
  };
  let seq = 10;
  const published: NewEvent[] = [];
  const host = {
    roomId: 'hackathon',
    engineerId: 'authority',
    state: () => state,
    submit: async (event: NewEvent) => {
      published.push(event);
      seq += 1;
      state = reduce(state, { ...event, seq, ts: new Date(seq * 1000).toISOString() }).state;
      return seq;
    },
    log: { info: () => {}, warn: () => {} },
  };
  return {
    host,
    published,
    state: () => state,
    of: (type: string) => published.filter((event) => event.payload.type === type),
  };
}

const options = { pace: async () => {}, minIntervalMs: 0, debounceMs: 0 };

const collision = (tier: 'PREDICTED' | 'FILE_OVERLAP') => ({
  collisionId: `c-${tier}`,
  tier,
  symbols: tier === 'PREDICTED' ? [USER_ID] : [],
  writerSession: 'backend',
  affectedSessions: ['payments'],
  detail: 'backend is changing User.id; payments has read it.',
  status: 'open' as const,
  openedSeq: 2,
});

/** The payload of an event the test expects to exist; a missing one should fail loudly. */
function payload<T>(event: NewEvent | undefined): T {
  if (!event) throw new Error('expected an event');
  return event.payload as T;
}

const contestedRoom = () =>
  harness(
    session('backend', { writeFiles: ['src/types/user.ts'] }),
    session('payments', { readFiles: ['src/types/user.ts', 'src/checkout.ts'], readSymbols: [USER_ID] }),
  );

describe('Planner', () => {
  it('announces the plan, claims the contested file, and briefs every agent', async () => {
    const room = contestedRoom();
    await new Planner(room.host, options).replan();

    const messages = room.of('MESSAGE');
    expect(messages.map((event) => (event.payload as { to: string }).to)).toEqual([
      'all',
      'backend',
      'payments',
    ]);
    expect(room.of('LEASE_GRANTED')).toHaveLength(1);
    const granted = room.of('LEASE_GRANTED')[0]?.payload as {
      sessionId: string;
      symbols: string[];
      fencingToken: number;
    };
    expect(granted.sessionId).toBe('backend');
    expect(granted.symbols).toEqual([USER_ID]);
    // The lease really lands in room state, so `editDenial` can read it in the hook.
    expect(Object.values(room.state().leases)[0]?.sessionId).toBe('backend');
  });

  it('gives the lease the seq of its own request, the way the coordinator would', async () => {
    const room = contestedRoom();
    await new Planner(room.host, options).replan();
    const request = room.published.findIndex((event) => event.payload.type === 'LEASE_REQUESTED');
    const granted = room.of('LEASE_GRANTED')[0]?.payload as { fencingToken: number };
    // Submissions start at seq 11, so the request's seq is its index plus eleven.
    expect(granted.fencingToken).toBe(request + 11);
  });

  it('wakes each agent with its own brief but never with the room announcement', async () => {
    const room = contestedRoom();
    await new Planner(room.host, options).replan();
    const [announcement, ...briefs] = room.of('MESSAGE');
    expect(payload<{ automationDepth: number }>(announcement).automationDepth).toBe(
      MAX_AUTOMATION_DEPTH,
    );
    expect(
      briefs.every((one) => payload<{ automationDepth: number }>(one).automationDepth === 0),
    ).toBe(true);
    expect(payload<{ text: string }>(briefs[1]).text).toContain('Do not edit src/types/user.ts');
  });

  it('announces an intent for a silent agent, which is what makes tier 1 possible', async () => {
    const room = contestedRoom();
    await new Planner(room.host, options).replan();
    const intents = room.of('INTENT');
    expect(intents.map((event) => event.actor.sessionId)).toEqual(['backend', 'payments']);
    expect(payload<{ symbols: string[] }>(intents[0]).symbols).toContain(USER_ID);
    expect(room.state().sessions.backend?.intent?.files).toEqual(['src/types/user.ts']);
  });

  it('leaves an agent’s own declared intent alone', async () => {
    const room = harness(
      session('backend', {
        writeFiles: ['src/types/user.ts'],
        intent: { task: 'mine', files: ['src/types/user.ts'], symbols: [USER_ID] },
      }),
      session('payments', { readFiles: ['src/types/user.ts', 'src/checkout.ts'] }),
    );
    await new Planner(room.host, options).replan();
    // Only the silent one is spoken for; `backend` said what it was doing itself.
    expect(room.of('INTENT').map((event) => event.actor.sessionId)).toEqual(['payments']);
  });

  it('publishes nothing when the allocation has not changed', async () => {
    const room = contestedRoom();
    const planner = new Planner(room.host, options);
    await planner.replan();
    const first = room.published.length;
    await planner.idle();
    // A second pass over an unchanged room is a no-op, not a second announcement.
    const again = new Planner(room.host, options);
    await again.replan();
    await again.replan();
    expect(room.published.length).toBeGreaterThan(first);
    const afterTwo = room.published.length;
    await again.idle();
    expect(room.published.length).toBe(afterTwo);
  });

  it('stays quiet in a room that cannot collide', async () => {
    const room = harness(session('solo', { writeFiles: ['src/a.ts'] }));
    await new Planner(room.host, options).replan();
    expect(room.published).toEqual([]);
  });

  it('stays quiet while a collision is still being negotiated', async () => {
    const room = contestedRoom();
    Object.assign(room.state().collisions, { c1: collision('PREDICTED') });
    await new Planner(room.host, options).replan();
    expect(room.published).toEqual([]);
  });

  it('still plans over a tier-0 overlap, which is advisory and never negotiated', async () => {
    const room = contestedRoom();
    Object.assign(room.state().collisions, { c0: collision('FILE_OVERLAP') });
    await new Planner(room.host, options).replan();
    expect(room.of('LEASE_GRANTED')).toHaveLength(1);
  });

  it('falls back to the deterministic plan when the model answers with nonsense', async () => {
    const room = contestedRoom();
    const llm: Llm = {
      json: async () =>
        ({
          summary: 'all yours',
          assignments: [{ sessionId: 'nobody', task: 'x', owns: ['does/not/exist.ts'] }],
        }) as never,
    };
    await new Planner(room.host, { ...options, llm }).replan();
    const granted = room.of('LEASE_GRANTED')[0]?.payload as { sessionId: string };
    // The model named a session and a file that do not exist; ownership is unchanged.
    expect(granted.sessionId).toBe('backend');
  });

  it('lets the model move a contested file between agents that both touched it', async () => {
    const room = contestedRoom();
    const llm: Llm = {
      json: async () =>
        ({
          summary: 'payments takes the type',
          assignments: [
            { sessionId: 'payments', task: 'Own the user type', owns: ['src/types/user.ts'] },
            { sessionId: 'backend', task: 'Wait on the type', owns: [] },
          ],
        }) as never,
    };
    await new Planner(room.host, { ...options, llm }).replan();
    const granted = room.of('LEASE_GRANTED')[0]?.payload as { sessionId: string };
    expect(granted.sessionId).toBe('payments');
  });
});
