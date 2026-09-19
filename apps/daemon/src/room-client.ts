import { redactPayload } from '@agentigram/adapters';
import {
  type ClientKind,
  type Event,
  type NewEvent,
  NewEventSchema,
  type RoomState,
  ServerMessageSchema,
  ValidationError,
} from '@agentigram/protocol';
import WebSocket from 'ws';
import type { Cursor } from './cursor-store.js';

export type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type RoomClientOptions = {
  /** e.g. ws://localhost:8787 (the `/room/:roomId` path is appended). */
  url: string;
  roomId: string;
  client: ClientKind;
  token: string;
  sessionId?: string;
  cursor: Cursor;
  log: Log;
  onEvents(events: Event[]): void;
  onWelcome?(state: RoomState): void;
  heartbeatMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
};

type Pending = { event: NewEvent; resolve(seq: number): void; reject(err: Error): void };

/**
 * A room connection that resumes on its own: HELLO with the persisted `lastSeq`, replay of the
 * gap, exponential-backoff reconnects, and at-least-once submits (the coordinator dedupes by id).
 * Everything received is parsed with the protocol schema; everything sent is redacted (rules 2, 7).
 */
export class RoomClient {
  private ws: WebSocket | undefined;
  private stopped = false;
  private attempt = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly o: RoomClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.ws?.close();
    for (const p of this.pending.values()) p.reject(new Error('client stopped'));
    this.pending.clear();
  }

  /** Validates, redacts and sends an event. Resolves with the assigned `seq` once ACKed. */
  submit(input: NewEvent): Promise<number> {
    const parsed = NewEventSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(new ValidationError('invalid event', parsed.error.issues));
    }
    const safe = NewEventSchema.parse({
      ...parsed.data,
      payload: redactPayload(parsed.data.payload),
    });
    return new Promise<number>((resolve, reject) => {
      this.pending.set(safe.id, { event: safe, resolve, reject });
      this.flush(safe.id);
    });
  }

  private connect(): void {
    const ws = new WebSocket(`${this.o.url}/room/${this.o.roomId}`);
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      const { roomId, client, token, sessionId, cursor } = this.o;
      this.send({
        type: 'HELLO',
        roomId,
        lastSeq: cursor.get(),
        client,
        token,
        ...(sessionId ? { sessionId } : {}),
      });
      for (const id of this.pending.keys()) this.flush(id); // resend unACKed: safe, ids dedupe
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(
        () => this.send({ type: 'HEARTBEAT', ...(sessionId ? { sessionId } : {}) }),
        this.o.heartbeatMs ?? 15_000,
      );
    });
    ws.on('message', (raw) => this.receive(raw.toString()));
    ws.on('error', (err) =>
      this.o.log.warn({ roomId: this.o.roomId, err: err.message }, 'socket error'),
    );
    ws.on('close', () => {
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      const delay = Math.min(
        (this.o.reconnectInitialMs ?? 1000) * 2 ** this.attempt++,
        this.o.reconnectMaxMs ?? 30_000,
      );
      this.o.log.info({ roomId: this.o.roomId, delay }, 'disconnected; reconnecting');
      this.retry = setTimeout(() => this.connect(), delay);
    });
  }

  private receive(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.o.log.warn({ roomId: this.o.roomId }, 'dropped non-JSON server message');
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.o.log.warn(
        { roomId: this.o.roomId, issue: parsed.error.issues[0]?.message },
        'dropped invalid server message',
      );
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'WELCOME':
        this.o.onWelcome?.(msg.roomState);
        break;
      case 'EVENTS': {
        const fresh = msg.events
          .filter((e) => e.seq > this.o.cursor.get())
          .sort((a, b) => a.seq - b.seq);
        if (fresh.length === 0) break;
        this.o.onEvents(fresh);
        this.o.cursor.set(fresh[fresh.length - 1]?.seq ?? 0);
        break;
      }
      case 'ACK':
        this.pending.get(msg.id)?.resolve(msg.seq);
        this.pending.delete(msg.id);
        break;
      case 'ERROR':
        this.o.log.error({ roomId: this.o.roomId, code: msg.code }, msg.message);
        if (msg.id) {
          this.pending.get(msg.id)?.reject(new Error(`${msg.code}: ${msg.message}`));
          this.pending.delete(msg.id);
        }
        break;
    }
  }

  private flush(id: string): void {
    const p = this.pending.get(id);
    if (p && this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'SUBMIT', event: p.event });
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}
