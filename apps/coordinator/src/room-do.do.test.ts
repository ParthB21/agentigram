import { exports } from 'cloudflare:workers';
import type { Event, NewEvent, Payload, ServerMessage } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';

// The Cloudflare test runtime exposes the worker's default export here; the generated `Exports`
// type does not list it, so it is typed once, in this cast.
const worker = (
  exports as unknown as { default: { fetch(url: string, init?: RequestInit): Promise<Response> } }
).default;

const SECRET = 'test-room-secret';
const WORKER_SECRET = 'test-worker-secret';
let counter = 0;
const uniqueRoom = () => `room-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

type Conn = {
  ws: WebSocket;
  inbox: ServerMessage[];
  events: () => Event[];
  send(m: unknown): void;
  until(pred: () => boolean): Promise<void>;
  close(): void;
};

async function connect(room: string): Promise<Conn> {
  const res = await worker.fetch(`http://coordinator/room/${room}`, {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (status ${res.status})`);
  ws.accept();
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener('message', (e: MessageEvent) => {
    inbox.push(JSON.parse(String(e.data)));
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!pred()) {
      if (Date.now() > deadline)
        throw new Error(`timed out; inbox=${JSON.stringify(inbox).slice(0, 400)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
  };
  return {
    ws,
    inbox,
    events: () => inbox.flatMap((m) => (m.type === 'EVENTS' ? m.events : [])),
    send: (m) => ws.send(JSON.stringify(m)),
    until,
    close: () => ws.close(1000, 'bye'),
  };
}

const hello = (room: string, client: 'daemon' | 'dashboard', lastSeq = 0, token = SECRET) => ({
  type: 'HELLO',
  roomId: room,
  lastSeq,
  client,
  token,
});
const agent = { engineerId: 'eng', sessionId: 'payments', kind: 'agent' } as const;
const submit = (room: string, id: string, payload: Payload, extra: Partial<NewEvent> = {}) => ({
  type: 'SUBMIT',
  event: { id, roomId: room, actor: agent, source: 'hook', payload, ...extra },
});
const started = (id: string) =>
  ({
    type: 'SESSION_STARTED',
    sessionId: id,
    host: 'claude-code',
    model: 'm',
    branch: 'b',
  }) as const;
const read = (n: number) => ({ type: 'FILE_READ', path: `src/f${n}.ts` }) as const;

async function greeted(room: string, client: 'daemon' | 'dashboard', lastSeq = 0) {
  const c = await connect(room);
  c.send(hello(room, client, lastSeq));
  await c.until(() => c.inbox.some((m) => m.type === 'WELCOME'));
  return c;
}

describe('coordinator Durable Object', () => {
  it('two daemons and a dashboard see identical ordered streams across a reconnect', async () => {
    const room = uniqueRoom();
    const a = await greeted(room, 'daemon');
    const b = await greeted(room, 'daemon');
    const dash = await greeted(room, 'dashboard');

    a.send(submit(room, 'e1', started('payments')));
    for (let i = 1; i <= 3; i++) a.send(submit(room, `r${i}`, read(i)));
    await b.until(() => b.events().length === 4);

    b.close(); // B drops...
    for (let i = 4; i <= 7; i++) a.send(submit(room, `r${i}`, read(i))); // ...and misses these

    const lastSeen = b.events().at(-1)?.seq ?? 0;
    const b2 = await greeted(room, 'daemon', lastSeen);
    await b2.until(() => b2.events().length === 4); // exactly the gap: seq 5..8
    await dash.until(() => dash.events().length === 8);
    await a.until(() => a.events().length === 8);

    const seqs = (c: Conn) => c.events().map((e) => e.seq);
    expect(seqs(a)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seqs(dash)).toEqual(seqs(a));
    expect([...seqs(b), ...seqs(b2)]).toEqual(seqs(a));
    expect(b.events().map((e) => e.id)).toEqual(
      a
        .events()
        .slice(0, 4)
        .map((e) => e.id),
    );
    expect(b2.inbox[0]).toMatchObject({ type: 'WELCOME', fromSeq: lastSeen });
  });

  it('dedupes a retried id: same ACK seq, one event', async () => {
    const room = uniqueRoom();
    const c = await greeted(room, 'daemon');
    c.send(submit(room, 'dup', started('payments')));
    c.send(submit(room, 'dup', started('payments')));
    await c.until(() => c.inbox.filter((m) => m.type === 'ACK').length === 2);
    const acks = c.inbox.filter((m) => m.type === 'ACK');
    expect(acks.map((a) => a.seq)).toEqual([1, 1]);
    const late = await greeted(room, 'dashboard');
    await late.until(() => late.events().length >= 1);
    expect(late.events()).toHaveLength(1);
  });

  it('rejects invalid input without consuming a seq', async () => {
    const room = uniqueRoom();
    const c = await greeted(room, 'daemon');
    c.ws.send('not json');
    c.send({ type: 'NOPE' });
    c.send(submit(room, 'bad', { type: 'NOPE' } as never));
    c.send(submit('other-room', 'wrong', read(1)));
    c.send(
      submit(room, 'forged', {
        type: 'LEASE_GRANTED',
        leaseId: 'l',
        symbols: [],
        fencingToken: 1,
        expiresAt: 'x',
      }),
    );
    await c.until(() => c.inbox.filter((m) => m.type === 'ERROR').length === 5);
    expect(c.inbox.filter((m) => m.type === 'ERROR').map((m) => m.code)).toEqual([
      'BAD_MESSAGE',
      'BAD_MESSAGE',
      'BAD_MESSAGE',
      'ROOM_MISMATCH',
      'UNAUTHORIZED',
    ]);
    c.send(submit(room, 'good', read(1)));
    await c.until(() => c.inbox.some((m) => m.type === 'ACK'));
    expect(c.inbox.find((m) => m.type === 'ACK')).toMatchObject({ id: 'good', seq: 1 });
  });

  it('refuses a bad token, and traffic before HELLO', async () => {
    const room = uniqueRoom();
    const cold = await connect(room);
    cold.send(submit(room, 'x', read(1)));
    await cold.until(() => cold.inbox.length === 1);
    expect(cold.inbox[0]).toMatchObject({ type: 'ERROR', code: 'NOT_HELLO' });

    const bad = await connect(room);
    bad.send(hello(room, 'daemon', 0, 'wrong'));
    await bad.until(() => bad.inbox.length === 1);
    expect(bad.inbox[0]).toMatchObject({ type: 'ERROR', code: 'UNAUTHORIZED' });
    expect(bad.inbox.some((m) => m.type === 'WELCOME')).toBe(false);
  });

  it('never delivers dashboard-only events to a daemon, live or on replay', async () => {
    const room = uniqueRoom();
    const daemon = await greeted(room, 'daemon');
    const dash = await greeted(room, 'dashboard');
    const human = { engineerId: 'alice', kind: 'human' } as const;
    dash.send(
      submit(
        room,
        'mkt',
        {
          type: 'MARKET_OPENED',
          marketId: 'm',
          kind: 'binary',
          question: 'q',
          outcomes: ['yes', 'no'],
          b: 100,
          closesAt: 'x',
        },
        { actor: human, source: 'system' },
      ),
    );
    daemon.send(submit(room, 'r1', read(1)));
    await dash.until(() => dash.events().length === 2);
    await daemon.until(() => daemon.events().length >= 1);
    expect(dash.events().map((e) => e.payload.type)).toEqual(['MARKET_OPENED', 'FILE_READ']);
    expect(daemon.events().map((e) => e.payload.type)).toEqual(['FILE_READ']);

    const replay = await greeted(room, 'daemon');
    await replay.until(() => replay.events().length >= 1);
    expect(replay.events().map((e) => e.payload.type)).toEqual(['FILE_READ']);
    const welcome = replay.inbox[0];
    expect(welcome?.type === 'WELCOME' && welcome.roomState.markets).toEqual({});
  });

  it('a daemon cannot trade, and a dashboard cannot act as an agent', async () => {
    const room = uniqueRoom();
    const daemon = await greeted(room, 'daemon');
    daemon.send(
      submit(room, 't', { type: 'TRADE', marketId: 'm', memberId: 'u', outcome: 'yes', shares: 1 }),
    );
    await daemon.until(() => daemon.inbox.some((m) => m.type === 'ERROR'));
    expect(daemon.inbox.find((m) => m.type === 'ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('HTTP ingest', () => {
  const post = (room: string, body: unknown, auth?: string) =>
    worker.fetch(`http://coordinator/room/${room}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ci = (room: string, id: string) => ({
    id,
    roomId: room,
    actor: { engineerId: 'system', kind: 'system' },
    source: 'github',
    payload: { type: 'CI_RESULT', commit: 'a1b2c3d', status: 'pass' },
  });

  it('requires the worker secret, not the room secret', async () => {
    const room = uniqueRoom();
    expect((await post(room, ci(room, 'c0'))).status).toBe(401);
    expect((await post(room, ci(room, 'c0'), `Bearer ${SECRET}`)).status).toBe(401);
    expect((await post(room, ci(room, 'c0'), 'Bearer ')).status).toBe(401);
  });

  it('accepts a server-side result, assigns a seq, fans it out, and dedupes retries', async () => {
    const room = uniqueRoom();
    const dash = await greeted(room, 'dashboard');
    const auth = `Bearer ${WORKER_SECRET}`;
    const first = await post(room, ci(room, 'c1'), auth);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: 'c1', seq: 1, duplicate: false });
    expect(await (await post(room, ci(room, 'c1'), auth)).json()).toMatchObject({
      seq: 1,
      duplicate: true,
    });
    await dash.until(() => dash.events().length === 1);
    expect(dash.events()[0]?.payload.type).toBe('CI_RESULT');
  });

  it('uses the same validation as SUBMIT', async () => {
    const room = uniqueRoom();
    const auth = `Bearer ${WORKER_SECRET}`;
    expect((await post(room, 'nope', auth)).status).toBe(400);
    expect((await post(room, { ...ci(room, 'x'), payload: { type: 'NOPE' } }, auth)).status).toBe(
      400,
    );
    expect((await post(room, { ...ci(room, 'y'), roomId: 'other' }, auth)).status).toBe(400);
    const notAllowed = { ...ci(room, 'z'), payload: { type: 'HEARTBEAT', sessionId: 's' } };
    expect((await post(room, notAllowed, auth)).status).toBe(403);
    expect((await post(room, 'x'.repeat(70_000), auth)).status).toBe(413);
  });

  it('only POST', async () => {
    const room = uniqueRoom();
    const res = await worker.fetch(`http://coordinator/room/${room}/ingest`, {
      headers: { Authorization: `Bearer ${WORKER_SECRET}` },
    });
    expect(res.status).toBe(405);
  });
});

describe('worker routing', () => {
  it('serves /health, 404s unknown paths, 426s a plain GET on a room', async () => {
    expect((await worker.fetch('http://coordinator/health')).status).toBe(200);
    expect((await worker.fetch('http://coordinator/nope')).status).toBe(404);
    expect((await worker.fetch('http://coordinator/room/../x')).status).toBe(404);
    expect((await worker.fetch(`http://coordinator/room/${uniqueRoom()}`)).status).toBe(426);
  });
});
