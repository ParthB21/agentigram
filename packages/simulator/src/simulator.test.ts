import {
  type Event,
  isAgentVisible,
  type ServerMessage,
  ServerMessageSchema,
} from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Room, type Sink } from './room.js';
import { checkScenario, runScenario } from './scenario.js';
import { userIdUuid } from './scenarios/user-id-uuid.js';
import { createMockCoordinator } from './server.js';

const collect = (kind: Sink['kind'], sessionId?: string) => {
  const events: Event[] = [];
  const messages: ServerMessage[] = [];
  const sink: Sink = {
    kind,
    ...(sessionId ? { sessionId } : {}),
    send(m) {
      messages.push(m);
      if (m.type === 'EVENTS') events.push(...m.events);
    },
  };
  return { sink, events, messages };
};

describe('user-id-uuid scenario', () => {
  it('has four sessions with distinct models and stable, unique event ids', () => {
    expect(userIdUuid.sessions).toHaveLength(4);
    expect(new Set(userIdUuid.sessions.map((s) => s.model)).size).toBe(4);
    expect(new Set(userIdUuid.steps.map((s) => s.event.id)).size).toBe(userIdUuid.steps.length);
  });

  it('satisfies its own assertions through the real reducer', () => {
    expect(checkScenario(userIdUuid, runScenario(userIdUuid))).toEqual([]);
  });

  it('is deterministic', () => {
    expect(runScenario(userIdUuid)).toEqual(runScenario(userIdUuid));
  });

  it('never routes dashboard-only events to agents (rule 5)', () => {
    const room = new Room('r', () => 1);
    const daemon = collect('daemon', 'payments');
    const worker = collect('worker');
    const dash = collect('dashboard');
    for (const c of [daemon, worker, dash]) room.join(c.sink, 0);
    for (const step of userIdUuid.steps) room.submit(step.event);

    expect(dash.events).toHaveLength(userIdUuid.steps.length);
    for (const c of [daemon, worker]) {
      expect(c.events.length).toBeGreaterThan(0);
      expect(c.events.every((e) => isAgentVisible(e.payload.type))).toBe(true);
    }
    expect(dash.events.some((e) => !isAgentVisible(e.payload.type))).toBe(true);
  });
});

describe('Room', () => {
  const first = userIdUuid.steps[0]?.event;
  if (!first) throw new Error('scenario is empty');

  it('assigns seq in order and dedupes by client id', () => {
    const room = new Room('r', () => 5);
    const a = room.submit(userIdUuid.steps[0]!.event);
    const b = room.submit(userIdUuid.steps[1]!.event);
    const again = room.submit(userIdUuid.steps[0]!.event);
    expect([a.event.seq, b.event.seq]).toEqual([1, 2]);
    expect(again).toMatchObject({ duplicate: true, event: { seq: 1 } });
    expect(room.log).toHaveLength(2);
  });

  it('replays only the gap after lastSeq, in order', () => {
    const room = new Room('r', () => 5);
    for (const step of userIdUuid.steps.slice(0, 6)) room.submit(step.event);
    const late = collect('dashboard');
    room.join(late.sink, 3);
    expect(late.messages[0]?.type).toBe('WELCOME');
    expect(late.events.map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it('keeps ts monotonic even if the clock goes backwards', () => {
    const times = [100, 50];
    const room = new Room('r', () => times.shift() ?? 0);
    const a = room.submit(userIdUuid.steps[0]!.event).event;
    const b = room.submit(userIdUuid.steps[1]!.event).event;
    expect(Date.parse(b.ts)).toBeGreaterThanOrEqual(Date.parse(a.ts));
  });
});

function connect(url: string) {
  const ws = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    inbox.push(ServerMessageSchema.parse(JSON.parse(raw.toString())));
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: (m: ServerMessage[]) => boolean) => {
    while (!pred(inbox)) await new Promise<void>((r) => waiters.push(r));
  };
  const opened = new Promise<void>((r) => ws.once('open', () => r()));
  return { ws, inbox, until, opened };
}

describe('mock coordinator over WebSocket', () => {
  it('replays a scenario to a late joiner, in order, and resumes from lastSeq', async () => {
    const server = await createMockCoordinator({ now: () => 1 });
    try {
      await server.play(
        { ...userIdUuid, steps: userIdUuid.steps.map((s) => ({ ...s, atMs: 0 })) },
        { roomId: 'hackathon' },
      );
      const total = userIdUuid.steps.length;

      const dash = connect(`${server.url}/room/hackathon`);
      await dash.opened;
      dash.ws.send(
        JSON.stringify({
          type: 'HELLO',
          roomId: 'hackathon',
          lastSeq: 0,
          client: 'dashboard',
          token: 't',
        }),
      );
      await dash.until((m) => m.some((x) => x.type === 'EVENTS'));
      const events = dash.inbox.flatMap((m) => (m.type === 'EVENTS' ? m.events : []));
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      dash.ws.close();

      const daemon = connect(`${server.url}/room/hackathon`);
      await daemon.opened;
      daemon.ws.send(
        JSON.stringify({
          type: 'HELLO',
          roomId: 'hackathon',
          lastSeq: total - 3,
          client: 'daemon',
          sessionId: 'payments',
          token: 't',
        }),
      );
      await daemon.until((m) => m.some((x) => x.type === 'EVENTS'));
      const resumed = daemon.inbox.flatMap((m) => (m.type === 'EVENTS' ? m.events : []));
      expect(resumed.every((e) => e.seq > total - 3 && isAgentVisible(e.payload.type))).toBe(true);
      daemon.ws.close();
    } finally {
      await server.close();
    }
  });

  it('acks a submit, dedupes a retry, and rejects malformed or pre-HELLO traffic', async () => {
    const server = await createMockCoordinator();
    try {
      const c = connect(`${server.url}/room/r1`);
      await c.opened;
      c.ws.send('not json');
      c.ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
      await c.until((m) => m.length >= 2);
      expect(c.inbox.map((m) => (m.type === 'ERROR' ? m.code : m.type))).toEqual([
        'BAD_MESSAGE',
        'NOT_HELLO',
      ]);

      c.ws.send(
        JSON.stringify({ type: 'HELLO', roomId: 'r1', lastSeq: 0, client: 'daemon', token: 't' }),
      );
      const submit = JSON.stringify({
        type: 'SUBMIT',
        event: { ...userIdUuid.steps[0]!.event, roomId: 'r1' },
      });
      c.ws.send(submit);
      c.ws.send(submit);
      await c.until((m) => m.filter((x) => x.type === 'ACK').length === 2);
      const acks = c.inbox.filter((m) => m.type === 'ACK');
      expect(acks.map((a) => a.seq)).toEqual([1, 1]);
      expect(server.room('r1').log).toHaveLength(1);
      c.ws.close();
    } finally {
      await server.close();
    }
  });
});
