import type { Duplex } from 'node:stream';
import {
  type ClientKind,
  type Event,
  EventSchema,
  type NewEvent,
  NewEventSchema,
  type RoomState,
  ServerMessageSchema,
} from '@agentigram/protocol';
import b4a from 'b4a';
import c from 'compact-encoding';
import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import { type ControlChannel, openControlChannel } from './channel.js';
import { discoveryTopic, type RoomInvite, RoomInviteSchema } from './invite.js';
import type { RoomTransport, TransportStatus } from './types.js';

export type P2PRoomTransportOptions = {
  invite: RoomInvite;
  storage: string;
  client: ClientKind;
  clientId: string;
  sessionId?: string;
  lastSeq?: number;
};

export class P2PRoomTransport implements RoomTransport {
  private readonly invite;
  private readonly store: Corestore;
  private readonly swarm = new Hyperswarm();
  private readonly eventCore;
  private channel: ControlChannel | undefined;
  private cursor: number;
  private connected = false;
  private eventListeners = new Set<(events: Event[]) => void>();
  private welcomeListeners = new Set<(state: RoomState) => void>();
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private pending = new Map<string, { resolve(seq: number): void; reject(error: Error): void }>();
  status: TransportStatus = 'connecting';

  constructor(private readonly options: P2PRoomTransportOptions) {
    this.invite = RoomInviteSchema.parse(options.invite);
    this.cursor = options.lastSeq ?? 0;
    this.store = new Corestore(options.storage);
    this.eventCore = this.store.get<string>({
      key: b4a.from(this.invite.eventCoreKey, 'hex'),
      valueEncoding: c.string,
    });
  }

  async start(): Promise<void> {
    await this.eventCore.ready();
    this.eventCore.on('append', () => void this.replay());
    this.swarm.on('connection', (socket, peerInfo) => {
      if (!b4a.equals(peerInfo.publicKey, b4a.from(this.invite.authorityPublicKey, 'hex'))) {
        socket.destroy();
        return;
      }
      this.attach(socket);
    });
    this.swarm.joinPeer(b4a.from(this.invite.authorityPublicKey, 'hex'));
    await this.swarm.join(discoveryTopic(this.invite), { server: false, client: true }).flushed();
    await this.replay();
  }

  async stop(): Promise<void> {
    this.setStatus('closed');
    this.channel?.close();
    for (const pending of this.pending.values()) pending.reject(new AuthorityUnavailableError());
    this.pending.clear();
    await this.swarm.destroy();
    await this.store.close();
  }

  submit(input: NewEvent): Promise<number> {
    const event = NewEventSchema.parse(input);
    if (!this.connected || !this.channel) return Promise.reject(new AuthorityUnavailableError());
    return new Promise<number>((resolve, reject) => {
      this.pending.set(event.id, { resolve, reject });
      this.channel?.send(JSON.stringify({ type: 'SUBMIT', event }));
    });
  }

  heartbeat(sessionId = this.options.sessionId): void {
    if (this.connected && this.channel) {
      this.channel.send(JSON.stringify({ type: 'HEARTBEAT', ...(sessionId ? { sessionId } : {}) }));
    }
  }

  onEvents(listener: (events: Event[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onWelcome(listener: (state: RoomState) => void): () => void {
    this.welcomeListeners.add(listener);
    return () => this.welcomeListeners.delete(listener);
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private attach(socket: Duplex): void {
    this.store.replicate(socket);
    this.channel = openControlChannel(
      socket,
      JSON.stringify({ capability: this.invite.capability, peerId: this.options.clientId }),
      (value) => this.receive(value),
      () => {
        this.connected = false;
        if (this.status !== 'closed') this.setStatus('read-only');
      },
    );
    this.connected = true;
    this.setStatus('connected');
    this.channel.send(
      JSON.stringify({
        type: 'HELLO',
        roomId: this.invite.roomId,
        lastSeq: this.cursor,
        client: this.options.client,
        token: this.invite.capability,
        ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      }),
    );
  }

  private receive(value: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'WELCOME') {
      for (const listener of this.welcomeListeners) listener(message.roomState);
    } else if (message.type === 'EVENTS') {
      this.emit(message.events);
    } else if (message.type === 'ACK') {
      this.pending.get(message.id)?.resolve(message.seq);
      this.pending.delete(message.id);
    } else if (message.id) {
      this.pending.get(message.id)?.reject(new Error(`${message.code}: ${message.message}`));
      this.pending.delete(message.id);
    }
  }

  private async replay(): Promise<void> {
    const events: Event[] = [];
    for (let index = this.cursor; index < this.eventCore.length; index += 1) {
      const value = await this.eventCore.get(index);
      if (value === null) continue;
      const parsed = EventSchema.safeParse(JSON.parse(value));
      if (parsed.success) events.push(parsed.data);
    }
    this.emit(events);
  }

  private emit(events: readonly Event[]): void {
    const fresh = events.filter((event) => event.seq > this.cursor).sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0) return;
    this.cursor = fresh.at(-1)?.seq ?? this.cursor;
    for (const listener of this.eventListeners) listener(fresh);
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export class AuthorityUnavailableError extends Error {
  override readonly name = 'AuthorityUnavailableError';
  constructor() {
    super('authority laptop is unavailable; this peer is read-only');
  }
}
