import { DurableObject } from 'cloudflare:workers';
import {
  type ClientKind,
  ClientMessageSchema,
  type Event,
  type ServerMessage,
} from '@clankergram/protocol';
import { checkToken, safeEqual } from './authz.js';
import { MAX_EVENT_BYTES, RoomCore, type SubmitOutcome } from './room-core.js';
import { type Client, recipients } from './routing.js';
import { SqlEventStore } from './store.js';

export type Env = {
  ROOMS: DurableObjectNamespace<RoomDO>;
  /** HELLO token (stub auth, M1). */
  ROOM_SECRET?: string;
  /** Bearer token for HTTP ingest. Separate from ROOM_SECRET so a leaked daemon token cannot post results. */
  WORKER_SECRET?: string;
};

/** Per-socket state that survives hibernation (limit 16 KiB). */
type Attachment = { roomId: string; hello: boolean; kind?: ClientKind; sessionId?: string };

const MAX_FRAME = 128 * 1024;
const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{1,64})(\/ingest)?$/;

/** One Durable Object per room: a WebSocket Hibernation adapter over `RoomCore`. */
export class RoomDO extends DurableObject<Env> {
  private core: RoomCore | undefined;

  private coreFor(roomId: string): RoomCore {
    this.core ??= new RoomCore(roomId, new SqlEventStore(this.ctx.storage.sql, roomId));
    return this.core;
  }

  override async fetch(request: Request): Promise<Response> {
    const match = ROOM_PATH.exec(new URL(request.url).pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    const roomId = match[1];

    if (match[2]) return this.ingest(request, roomId);

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ roomId, hello: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** POST /room/:roomId/ingest — server-side results from workers, same validation as SUBMIT. */
  private async ingest(request: Request, roomId: string): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
    const secret = this.env.WORKER_SECRET;
    if (!secret || !safeEqual(bearer, secret)) return json({ error: 'unauthorized' }, 401);

    const body = await request.text();
    if (body.length > MAX_EVENT_BYTES) return json({ error: 'payload too large' }, 413);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return json({ error: 'not JSON' }, 400);
    }
    const out = this.coreFor(roomId).submit(input, { kind: 'worker' });
    if (!out.ok)
      return json({ error: out.message, code: out.code }, out.code === 'UNAUTHORIZED' ? 403 : 400);
    if (!out.duplicate) this.broadcast(out.event);
    return json({ id: out.event.id, seq: out.event.seq, duplicate: out.duplicate }, 200);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return void ws.close(1011, 'no attachment');
    const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
    const fail = (
      code: 'BAD_MESSAGE' | 'UNAUTHORIZED' | 'NOT_HELLO' | 'ROOM_MISMATCH',
      text: string,
      id?: string,
    ) => send({ type: 'ERROR', code, message: text, ...(id ? { id } : {}) });

    if (typeof message !== 'string') return fail('BAD_MESSAGE', 'binary frames are not supported');
    if (message.length > MAX_FRAME) return fail('BAD_MESSAGE', 'frame too large');
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return fail('BAD_MESSAGE', 'not JSON');
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success)
      return fail('BAD_MESSAGE', parsed.error.issues[0]?.message ?? 'invalid message');
    const msg = parsed.data;
    const core = this.coreFor(att.roomId);

    if (msg.type === 'HELLO') {
      if (msg.roomId !== att.roomId) return fail('ROOM_MISMATCH', `connected to ${att.roomId}`);
      if (!checkToken(msg.token, this.env.ROOM_SECRET)) {
        fail('UNAUTHORIZED', 'bad token');
        return ws.close(1008, 'unauthorized');
      }
      ws.serializeAttachment({
        roomId: att.roomId,
        hello: true,
        kind: msg.client,
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      } satisfies Attachment);
      for (const m of core.welcome(msg.client, msg.lastSeq)) send(m);
      return;
    }

    if (!att.hello || !att.kind) return fail('NOT_HELLO', 'send HELLO first');

    if (msg.type === 'HEARTBEAT') {
      const sessionId = att.sessionId ?? msg.sessionId;
      const beat = sessionId ? core.heartbeat(sessionId) : undefined;
      if (beat?.ok && !beat.duplicate) this.broadcast(beat.event);
      return;
    }

    const out: SubmitOutcome = core.submit(msg.event, {
      kind: att.kind,
      ...(att.sessionId ? { sessionId: att.sessionId } : {}),
    });
    if (!out.ok)
      return fail(
        out.code === 'ROOM_MISMATCH'
          ? 'ROOM_MISMATCH'
          : out.code === 'UNAUTHORIZED'
            ? 'UNAUTHORIZED'
            : 'BAD_MESSAGE',
        out.message,
        out.id,
      );
    send({ type: 'ACK', id: out.event.id, seq: out.event.seq });
    if (!out.duplicate) this.broadcast(out.event);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'socket error');
    } catch {
      // already closed
    }
  }

  /** Fan out to every greeted socket the router allows; unauthenticated sockets get nothing. */
  private broadcast(event: Event): void {
    const sockets = this.ctx.getWebSockets();
    const clients: Client[] = [];
    const byId = new Map<string, WebSocket>();
    sockets.forEach((ws, i) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.hello || !att.kind) return;
      const id = String(i);
      clients.push({ id, kind: att.kind, ...(att.sessionId ? { sessionId: att.sessionId } : {}) });
      byId.set(id, ws);
    });
    const frame = JSON.stringify({ type: 'EVENTS', events: [event] } satisfies ServerMessage);
    for (const c of recipients(event, clients)) {
      try {
        byId.get(c.id)?.send(frame);
      } catch (err) {
        // A dead socket must not stop the fan-out to the others, but it must be visible.
        console.warn(
          JSON.stringify({
            msg: 'fan-out send failed',
            seq: event.seq,
            kind: c.kind,
            err: String(err),
          }),
        );
      }
    }
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
