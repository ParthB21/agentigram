import { type Event, type NewEvent, type Payload, symbolKey } from '@agentigram/protocol';
import { runScenario, SCENARIO_EPOCH_MS, userIdUuid } from '@agentigram/simulator';
import { describe, expect, it } from 'vitest';
import { checkToken, safeEqual } from './authz.js';
import { RoomCore } from './room-core.js';
import { recipients } from './routing.js';
import { MemoryEventStore } from './store.js';

const SYSTEM = { kind: 'system' } as const;
const DAEMON = { kind: 'daemon' } as const;

let n = 0;
const ev = (payload: Payload, over: Partial<NewEvent> = {}): NewEvent => ({
  id: `t-${++n}`,
  roomId: 'r',
  actor: { engineerId: 'eng', sessionId: 's1', kind: 'agent' },
  source: 'hook',
  payload,
  ...over,
});
const hb = (over: Partial<NewEvent> = {}) => ev({ type: 'HEARTBEAT', sessionId: 's1' }, over);
const started = (id = 's1') =>
  ev({ type: 'SESSION_STARTED', sessionId: id, host: 'claude-code', model: 'm', branch: 'b' });
const make = (store = new MemoryEventStore(), opts = {}) => new RoomCore('r', store, opts);

describe('ordering and dedupe', () => {
  it('assigns dense, increasing seq and monotonic ts even if the clock steps back', () => {
    const times = [1000, 500, 2000];
    const core = make(undefined, { now: () => times.shift() ?? 3000 });
    const out = [started(), hb(), hb()].map((e) => core.submit(e, DAEMON));
    const events = out.map((o) => (o.ok ? o.event : undefined));
    expect(events.map((e) => e?.seq)).toEqual([1, 2, 3]);
    const ts = events.map((e) => Date.parse(e?.ts ?? ''));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('returns the original event for a retried id and does not apply it twice', () => {
    const core = make();
    const e = started();
    const a = core.submit(e, DAEMON);
    const b = core.submit(e, DAEMON);
    expect(a.ok && b.ok && b.duplicate && b.event.seq === a.event.seq).toBe(true);
    expect(core.head).toBe(1);
    expect(core.eventsAfter(0)).toHaveLength(1);
  });
});

describe('authoritative leases and fencing', () => {
  const userId = symbolKey('src/types/user.ts', 'User', 'id', 'property');

  it('grants the first claim, denies a conflict, and enforces the fencing token', () => {
    const core = make();
    core.submit(started('s1'), SYSTEM);
    core.submit(started('s2'), SYSTEM);
    const first = core.submit(
      ev({ type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 600_000 }, { source: 'mcp' }),
      { kind: 'daemon', sessionId: 's1' },
    );
    expect(first.ok && first.events.map((event) => event.payload.type)).toEqual([
      'LEASE_REQUESTED',
      'LEASE_GRANTED',
    ]);
    const lease = Object.values(core.currentState.leases)[0];
    expect(lease).toMatchObject({ sessionId: 's1', fencingToken: first.ok ? first.event.seq : -1 });

    const second = core.submit(
      ev(
        { type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 600_000 },
        {
          actor: { engineerId: 'two', sessionId: 's2', kind: 'agent' },
          source: 'mcp',
        },
      ),
      { kind: 'daemon', sessionId: 's2' },
    );
    expect(second.ok && second.events.at(-1)?.payload).toMatchObject({
      type: 'LEASE_DENIED',
      heldBy: 's1',
    });

    const write = (sessionId: string, fencingToken?: number) =>
      ev(
        { type: 'FILE_WRITE', path: 'src/types/user.ts', worktree: '/repo', fencingToken },
        { actor: { engineerId: sessionId, sessionId, kind: 'agent' } },
      );
    expect(core.submit(write('s2'), { kind: 'daemon', sessionId: 's2' })).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    });
    expect(core.submit(write('s1', 0), { kind: 'daemon', sessionId: 's1' })).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    });
    expect(
      core.submit(write('s1', lease?.fencingToken), { kind: 'daemon', sessionId: 's1' }).ok,
    ).toBe(true);
  });

  it('expires leases by authority time and permits a human override', () => {
    let now = Date.UTC(2026, 8, 19, 12);
    const core = make(undefined, { now: () => now });
    core.submit(started('s1'), SYSTEM);
    core.submit(
      ev({ type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 1_000 }, { source: 'mcp' }),
      { kind: 'daemon', sessionId: 's1' },
    );
    const leaseId = Object.keys(core.currentState.leases)[0];
    expect(leaseId).toBeTruthy();
    const released = core.submit(
      ev(
        { type: 'LEASE_RELEASED', leaseId: leaseId ?? '' },
        { actor: { engineerId: 'owner', kind: 'human' }, source: 'mcp' },
      ),
      { kind: 'dashboard' },
    );
    expect(released.ok).toBe(true);
    expect(core.currentState.leases).toEqual({});

    core.submit(
      ev({ type: 'LEASE_REQUESTED', symbols: [userId], ttlMs: 1_000 }, { source: 'mcp' }),
      { kind: 'daemon', sessionId: 's1' },
    );
    now = Date.parse(Object.values(core.currentState.leases)[0]?.expiresAt ?? '') + 1;
    expect(core.expireLeases()).toHaveLength(1);
    expect(core.currentState.leases).toEqual({});
  });
});

describe('untrusted input', () => {
  it.each([
    ['unknown payload type', { ...started(), payload: { type: 'NOPE' } }, 'BAD_MESSAGE'],
    ['missing fields', { id: 'x', roomId: 'r' }, 'BAD_MESSAGE'],
    ['not an object', 'hello', 'BAD_MESSAGE'],
    ['null', null, 'BAD_MESSAGE'],
    ['wrong room', started() && { ...started(), roomId: 'other' }, 'ROOM_MISMATCH'],
  ])('rejects %s', (_name, input, code) => {
    const out = make().submit(input, DAEMON);
    expect(out).toMatchObject({ ok: false, code });
  });

  it('rejects oversized events', () => {
    const big = ev({ type: 'DISCOVERY', text: 'x'.repeat(70_000) });
    expect(make().submit(big, DAEMON)).toMatchObject({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('a rejected event consumes no seq and leaves no trace', () => {
    const core = make();
    core.submit({ nope: true }, DAEMON);
    expect(core.head).toBe(0);
    const ok = core.submit(started(), DAEMON);
    expect(ok.ok && ok.event.seq).toBe(1);
  });

  it('does not let a client choose seq or ts', () => {
    const forged = { ...started(), seq: 999, ts: '1999-01-01T00:00:00.000Z' };
    const out = make().submit(forged, DAEMON);
    expect(out.ok && out.event.seq).toBe(1);
    expect(out.ok && out.event.ts).not.toBe('1999-01-01T00:00:00.000Z');
  });
});

describe('authorisation', () => {
  it('daemons cannot forge coordinator, worker or market events, or act as system', () => {
    const core = make();
    const forged: Payload[] = [
      { type: 'LEASE_GRANTED', leaseId: 'l', symbols: [], fencingToken: 1, expiresAt: 'x' },
      { type: 'RUN_VERIFIED', runId: 'r', sessionId: 's1' },
      { type: 'CI_RESULT', commit: 'a', status: 'pass' },
      { type: 'TRADE', marketId: 'm', memberId: 'u', outcome: 'yes', shares: 1 },
      { type: 'PERSONA_LINES', lines: [] },
    ];
    for (const p of forged)
      expect(core.submit(ev(p), DAEMON)).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(core.submit(hb({ actor: { engineerId: 'e', kind: 'system' } }), DAEMON)).toMatchObject({
      ok: false,
    });
    expect(core.submit(hb({ source: 'github' }), DAEMON)).toMatchObject({ ok: false });
    const discovery = ev({ type: 'DISCOVERY', text: 'x' }, { source: 'system' });
    expect(core.submit(discovery, DAEMON)).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(core.head).toBe(0);
  });

  it('accepts a daemon heartbeat stamped source=system (its own liveness beat)', () => {
    const core = make();
    expect(core.submit(started(), DAEMON).ok).toBe(true);
    expect(core.submit(hb({ source: 'system' }), DAEMON).ok).toBe(true);
  });

  it('a daemon that announced a session may only speak for it', () => {
    const core = make();
    const bound = { kind: 'daemon', sessionId: 's1' } as const;
    expect(core.submit(hb(), bound).ok).toBe(true);
    expect(
      core.submit(hb({ actor: { engineerId: 'e', sessionId: 's2', kind: 'agent' } }), bound),
    ).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    });
  });

  it('workers may post only server-side results; dashboards only human actions', () => {
    const core = make();
    const sys = { engineerId: 'system', kind: 'system' } as const;
    const human = { engineerId: 'alice', kind: 'human' } as const;
    const result = ev(
      { type: 'CI_RESULT', commit: 'a', status: 'pass' },
      { actor: sys, source: 'github' },
    );
    expect(core.submit(result, { kind: 'worker' }).ok).toBe(true);
    expect(core.submit(hb({ actor: sys }), { kind: 'worker' })).toMatchObject({ ok: false });
    const trade = ev(
      { type: 'TRADE', marketId: 'm', memberId: 'alice', outcome: 'yes', shares: 1 },
      { actor: human, source: 'system' },
    );
    expect(core.submit(trade, { kind: 'dashboard' }).ok).toBe(true);
    expect(
      core.submit(
        { ...trade, id: 'other', actor: { engineerId: 'a', kind: 'agent' } },
        { kind: 'dashboard' },
      ),
    ).toMatchObject({ ok: false });
    expect(core.submit(hb({ actor: human }), { kind: 'dashboard' })).toMatchObject({ ok: false });
  });

  it('compares secrets in constant time and rejects missing secrets', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(checkToken('s3cret', 's3cret')).toBe(true);
    expect(checkToken('', '')).toBe(false);
    expect(checkToken('x', undefined)).toBe(false);
  });
});

describe('welcome and replay', () => {
  const fill = (core: RoomCore, count: number) => {
    core.submit(started(), SYSTEM);
    for (let i = 1; i < count; i++) core.submit(hb(), SYSTEM);
  };
  const seqs = (msgs: ReturnType<RoomCore['welcome']>) =>
    msgs.flatMap((m) => (m.type === 'EVENTS' ? m.events.map((e) => e.seq) : []));

  it('sends WELCOME first, then only the gap after lastSeq, in order', () => {
    const core = make(undefined, { replayBatch: 3 });
    fill(core, 10);
    const msgs = core.welcome('dashboard', 4);
    expect(msgs[0]).toMatchObject({ type: 'WELCOME', fromSeq: 4 });
    expect(seqs(msgs)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(msgs.filter((m) => m.type === 'EVENTS')).toHaveLength(2); // batched 3 + 3
  });

  it('replays everything to a client that is ahead of the room', () => {
    const core = make();
    fill(core, 3);
    expect(seqs(core.welcome('dashboard', 50))).toEqual([1, 2, 3]);
  });

  it('never replays dashboard-only events to daemons, and strips markets from their state', () => {
    const core = make();
    core.submit(started(), SYSTEM);
    core.submit(
      ev({
        type: 'MARKET_OPENED',
        marketId: 'm',
        kind: 'binary',
        question: 'q',
        outcomes: ['yes', 'no'],
        b: 100,
        closesAt: 'x',
      }),
      SYSTEM,
    );
    core.submit(hb(), SYSTEM);
    expect(seqs(core.welcome('daemon', 0))).toEqual([1, 3]);
    expect(seqs(core.welcome('worker', 0))).toEqual([1, 3]);
    expect(seqs(core.welcome('dashboard', 0))).toEqual([1, 2, 3]);
  });

  it('routes by audience', () => {
    const core = make();
    const out = core.submit(
      ev({ type: 'TRADE', marketId: 'm', memberId: 'u', outcome: 'yes', shares: 1 }),
      SYSTEM,
    );
    if (!out.ok) throw new Error('expected ok');
    const clients = [
      { id: 'a', kind: 'daemon' as const },
      { id: 'b', kind: 'worker' as const },
      { id: 'c', kind: 'dashboard' as const },
    ];
    expect(recipients(out.event, clients).map((c) => c.id)).toEqual(['c']);
    const heartbeat = core.submit(hb(), SYSTEM);
    if (!heartbeat.ok) throw new Error('expected ok');
    expect(recipients(heartbeat.event, clients)).toHaveLength(3);
  });
});

describe('rehydration', () => {
  it('a room that wakes from snapshot + replay equals the one that never slept, and continues the seq', () => {
    const store = new MemoryEventStore();
    const live = make(store, { snapshotEvery: 5 });
    live.submit(started(), SYSTEM);
    for (let i = 0; i < 12; i++) live.submit(hb(), SYSTEM);
    expect(store.loadSnapshot()?.seq).toBe(10);

    const woke = make(store, { snapshotEvery: 5 });
    expect(woke.head).toBe(live.head);
    expect(woke.stateFor('dashboard')).toEqual(live.stateFor('dashboard'));
    const next = woke.submit(hb(), SYSTEM);
    expect(next.ok && next.event.seq).toBe(14);
  });

  it('wakes from the full log when there is no usable snapshot', () => {
    const store = new MemoryEventStore();
    const live = make(store, { snapshotEvery: 1000 });
    live.submit(started(), SYSTEM);
    live.submit(hb(), SYSTEM);
    expect(make(store).stateFor('dashboard')).toEqual(live.stateFor('dashboard'));
  });

  it('keeps ts monotonic across a wake', () => {
    const store = new MemoryEventStore();
    make(store, { now: () => 10_000 }).submit(started(), SYSTEM);
    const woke = make(store, { now: () => 5_000 }); // clock behind the log
    const out = woke.submit(hb(), SYSTEM);
    expect(out.ok && Date.parse(out.event.ts)).toBeGreaterThanOrEqual(10_000);
  });
});

describe('presence', () => {
  it('goes stale after 30 s without a heartbeat and recovers on a wire heartbeat', () => {
    let t = SCENARIO_EPOCH_MS;
    const core = make(undefined, { now: () => t });
    core.submit(started(), SYSTEM);
    expect(core.presence().s1).toBe('live');
    t += 31_000;
    expect(core.presence().s1).toBe('stale');
    const beat = core.heartbeat('s1');
    expect(beat?.ok && beat.event.payload.type).toBe('HEARTBEAT');
    expect(core.presence().s1).toBe('live');
    core.submit(ev({ type: 'SESSION_ENDED', sessionId: 's1' }), SYSTEM);
    expect(core.presence().s1).toBe('ended');
    expect(core.heartbeat('s1')).toBeUndefined();
  });

  it('throttles logged heartbeats and ignores unknown sessions', () => {
    let t = SCENARIO_EPOCH_MS;
    const core = make(undefined, { now: () => t });
    core.submit(started(), SYSTEM);
    expect(core.heartbeat('s1')).toBeUndefined(); // just started
    t += 5_000;
    expect(core.heartbeat('s1')).toBeUndefined();
    t += 6_000;
    expect(core.heartbeat('s1')?.ok).toBe(true);
    expect(core.heartbeat('s1')).toBeUndefined();
    expect(core.heartbeat('ghost')).toBeUndefined();
    expect(core.head).toBe(2);
  });

  it('ends a disconnected session immediately and allows the same id to rejoin', () => {
    const core = make();
    core.submit(started(), SYSTEM);

    const ended = core.endSession('s1', 'disconnect');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toEqual({
      type: 'SESSION_ENDED',
      sessionId: 's1',
      reason: 'disconnect',
    });
    expect(core.presence().s1).toBe('ended');
    expect(core.endSession('s1', 'disconnect')).toEqual([]);

    core.submit(started(), SYSTEM);
    expect(core.presence().s1).toBe('live');
    expect(core.stateFor('dashboard').sessions.s1?.status).toBe('active');
  });
});

describe('conformance with the simulator', () => {
  it('user-id-uuid through the real core yields the same state as the headless run', () => {
    let step = 0;
    const core = make(undefined, {
      now: () => SCENARIO_EPOCH_MS + (userIdUuid.steps[step]?.atMs ?? 0),
    });
    const events: Event[] = [];
    for (step = 0; step < userIdUuid.steps.length; step++) {
      const s = userIdUuid.steps[step];
      const out = core.submit({ ...s?.event, roomId: 'r' }, SYSTEM);
      if (!out.ok) throw new Error(out.message);
      events.push(out.event);
    }
    const headless = runScenario(userIdUuid, 'r');
    expect(events).toEqual(headless.events);
    expect(core.stateFor('dashboard')).toEqual(headless.state);
  });
});
