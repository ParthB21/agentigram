import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClientMessageSchema, type ErrorCode, type ServerMessage } from '@clankergram/protocol';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { Room, type Sink } from './room.js';
import type { Scenario } from './scenario.js';

export type MockCoordinatorOptions = {
  port?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export type PlayOptions = { roomId: string; speed?: number };

export type MockCoordinator = {
  port: number;
  url: string;
  room(roomId: string): Room;
  /** Replays a scenario into a room on a timer. Resolves when the last step has been submitted. */
  play(scenario: Scenario, options: PlayOptions): Promise<void>;
  close(): Promise<void>;
};

const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{1,64})$/;

/** Mock coordinator: a WebSocket server on `/room/:roomId` speaking the wire protocol. */
export async function createMockCoordinator(
  options: MockCoordinatorOptions = {},
): Promise<MockCoordinator> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const timers = new Set<NodeJS.Timeout>();
  const room = (id: string) => {
    let r = rooms.get(id);
    if (!r) {
      r = new Room(id, now);
      rooms.set(id, r);
    }
    return r;
  };

  const http = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404).end(req.url === '/health' ? 'ok' : '');
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const match = ROOM_PATH.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (!match?.[1]) {
      socket.destroy();
      return;
    }
    const roomId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, roomId));
  });

  function connect(ws: WebSocket, roomId: string): void {
    const target = room(roomId);
    let sink: Sink | undefined;
    const send = (m: ServerMessage) =>
      ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const fail = (code: ErrorCode, message: string, id?: string) =>
      send({ type: 'ERROR', code, message, ...(id ? { id } : {}) });

    ws.on('message', (raw: RawData) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return fail('BAD_MESSAGE', 'not JSON');
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) return fail('BAD_MESSAGE', parsed.error.issues[0]?.message ?? 'invalid');
      const msg = parsed.data;

      if (msg.type === 'HELLO') {
        if (msg.roomId !== roomId) return fail('ROOM_MISMATCH', `connected to ${roomId}`);
        if (!msg.token) return fail('UNAUTHORIZED', 'token required');
        if (sink) target.leave(sink);
        sink = { kind: msg.client, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), send };
        target.join(sink, msg.lastSeq);
        log(`hello room=${roomId} client=${msg.client} lastSeq=${msg.lastSeq}`);
      } else if (!sink) {
        fail('NOT_HELLO', 'send HELLO first');
      } else if (msg.type === 'SUBMIT') {
        if (msg.event.roomId !== roomId) return fail('ROOM_MISMATCH', 'event.roomId', msg.event.id);
        const { event } = target.submit(msg.event);
        send({ type: 'ACK', id: event.id, seq: event.seq });
      }
      // HEARTBEAT: accepted; the mock does not expire presence.
    });
    ws.on('close', () => sink && target.leave(sink));
    ws.on('error', (err) => log(`socket error: ${err.message}`));
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, resolve);
  });
  const port = (http.address() as AddressInfo).port;

  return {
    port,
    url: `ws://localhost:${port}`,
    room,
    play(scenario, { roomId, speed = 1 }) {
      const target = room(roomId);
      return new Promise<void>((resolve) => {
        if (scenario.steps.length === 0) return resolve();
        let remaining = scenario.steps.length;
        for (const step of scenario.steps) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            target.submit({ ...step.event, roomId });
            if (--remaining === 0) resolve();
          }, step.atMs / speed);
          timers.add(timer);
        }
      });
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
    },
  };
}
