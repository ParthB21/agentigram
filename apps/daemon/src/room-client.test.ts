import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Event, isAgentVisible } from '@clankergram/protocol';
import { createMockCoordinator, type MockCoordinator, userIdUuid } from '@clankergram/simulator';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorStore } from './cursor-store.js';
import { RoomClient } from './room-client.js';

const silent = { info() {}, warn() {}, error() {} };
const until = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let server: MockCoordinator | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const instant = { ...userIdUuid, steps: userIdUuid.steps.map((s) => ({ ...s, atMs: 0 })) };

describe('RoomClient against the simulator', () => {
  it('receives every agent-visible event in order, then resumes from its cursor', async () => {
    server = await createMockCoordinator();
    await server.play(instant, { roomId: 'hackathon' });
    const dir = mkdtempSync(join(tmpdir(), 'cg-'));

    const first: Event[] = [];
    const a = new RoomClient({
      url: server.url,
      roomId: 'hackathon',
      client: 'daemon',
      token: 't',
      sessionId: 'payments',
      cursor: CursorStore.forRoom('hackathon', dir),
      log: silent,
      onEvents: (e) => first.push(...e),
    });
    a.start();
    await until(() => first.length > 0);
    a.stop();

    const seqs = first.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(first.every((e) => isAgentVisible(e.payload.type))).toBe(true);
    expect(first.some((e) => e.payload.type === 'COLLISION')).toBe(true);

    // New events arrive while the daemon is down; the next connection gets only those.
    const head = server.room('hackathon').state.lastSeq;
    server.room('hackathon').submit({
      ...userIdUuid.steps[0]!.event,
      id: 'late-1',
      payload: { type: 'HEARTBEAT', sessionId: 'backend' },
    });
    const second: Event[] = [];
    const b = new RoomClient({
      url: server.url,
      roomId: 'hackathon',
      client: 'daemon',
      token: 't',
      cursor: CursorStore.forRoom('hackathon', dir),
      log: silent,
      onEvents: (e) => second.push(...e),
    });
    b.start();
    await until(() => second.length > 0);
    b.stop();
    expect(second.map((e) => e.seq)).toEqual([head + 1]);
  });

  it('submits an event, gets an ACK, and redacts secrets before sending', async () => {
    server = await createMockCoordinator();
    const cursor = { get: () => 0, set() {} };
    const c = new RoomClient({
      url: server.url,
      roomId: 'r',
      client: 'daemon',
      token: 't',
      cursor,
      log: silent,
      onEvents() {},
    });
    c.start();
    const seq = await c.submit({
      id: 'e-1',
      roomId: 'r',
      actor: { engineerId: 'eng', kind: 'agent' },
      source: 'mcp',
      payload: { type: 'DISCOVERY', text: 'found key sk-abcdef123456 in env' },
    });
    c.stop();
    expect(seq).toBe(1);
    const stored = server.room('r').log[0]?.payload;
    expect(stored?.type === 'DISCOVERY' && stored.text).not.toContain('abcdef123456');
  });

  it('rejects an invalid outbound event before it touches the wire', async () => {
    server = await createMockCoordinator();
    const c = new RoomClient({
      url: server.url,
      roomId: 'r',
      client: 'daemon',
      token: 't',
      cursor: { get: () => 0, set() {} },
      log: silent,
      onEvents() {},
    });
    await expect(c.submit({ id: 'x', payload: { type: 'NOPE' } } as never)).rejects.toThrow(
      'invalid event',
    );
  });

  it('reconnects after the server drops it and keeps its position', async () => {
    server = await createMockCoordinator();
    const got: number[] = [];
    const cursor = {
      n: 0,
      get() {
        return this.n;
      },
      set(s: number) {
        this.n = s;
      },
    };
    const c = new RoomClient({
      url: server.url,
      roomId: 'r',
      client: 'daemon',
      token: 't',
      cursor,
      log: silent,
      reconnectInitialMs: 20,
      onEvents: (e) => got.push(...e.map((x) => x.seq)),
    });
    const room = server.room('r');
    const hb = (id: string) => ({
      ...userIdUuid.steps[0]!.event,
      id,
      payload: { type: 'HEARTBEAT' as const, sessionId: 's' },
    });
    room.submit(hb('a'));
    c.start();
    await until(() => got.length === 1);
    // Server-side drop: terminate every socket by closing and reopening the room's listeners is not
    // exposed, so emulate a network cut through the client's own socket.
    (c as unknown as { ws: { terminate(): void } }).ws.terminate();
    room.submit(hb('b'));
    await until(() => got.length === 2);
    c.stop();
    expect(got).toEqual([1, 2]);
  });
});
