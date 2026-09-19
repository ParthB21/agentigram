import { join } from 'node:path';
import { RoomCore } from '@agentigram/coordinator';
import {
  type AuthorityPeer,
  encodeInvite,
  P2PRoomServer,
  type RoomInvite,
  type RoomTransport,
  type TransportStatus,
} from '@agentigram/p2p';
import type { Event, NewEvent, RoomState, ServerMessage } from '@agentigram/protocol';
import { FileEventStore } from './file-event-store.js';
import type { InstallState } from './install.js';

const LEASE_EXPIRY_POLL_MS = 1_000;

export class AuthorityTransport implements RoomTransport {
  private readonly core: RoomCore;
  private readonly server: P2PRoomServer;
  private eventListeners = new Set<(events: Event[]) => void>();
  private welcomeListeners = new Set<(state: RoomState) => void>();
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private expiryTimer: NodeJS.Timeout | undefined;
  private inviteValue: RoomInvite | undefined;
  status: TransportStatus = 'connecting';

  constructor(private readonly state: InstallState) {
    this.core = new RoomCore(
      state.roomId,
      new FileEventStore(join(state.p2pStorage, 'authority-state')),
    );
    this.server = new P2PRoomServer({
      roomId: state.roomId,
      repositoryFingerprint: state.repositoryFingerprint,
      storage: join(state.p2pStorage, 'hypercore'),
      capability: state.capability,
      handle: (message, peer) => this.handle(message, peer),
      onDisconnect: (peer) => this.disconnect(peer),
    });
  }

  get invite(): RoomInvite | undefined {
    return this.inviteValue;
  }

  get inviteUri(): string | undefined {
    return this.inviteValue ? encodeInvite(this.inviteValue) : undefined;
  }

  async start(): Promise<void> {
    this.inviteValue = await this.server.start();
    const missing = this.core.eventsAfter(this.server.historyLength);
    if (missing.length > 0) await this.server.publish(missing);
    this.setStatus('connected');
    for (const listener of this.welcomeListeners) listener(this.core.stateFor('daemon'));
    this.expiryTimer = setInterval(() => void this.expireLeases(), LEASE_EXPIRY_POLL_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.expiryTimer);
    await this.server.stop();
    this.setStatus('closed');
  }

  async submit(event: NewEvent): Promise<number> {
    const outcome = this.core.submit(event, { kind: 'daemon', sessionId: this.state.sessionId });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    if (!outcome.duplicate) await this.publish(outcome.events);
    return outcome.event.seq;
  }

  async submitAsHuman(event: NewEvent): Promise<number> {
    const outcome = this.core.submit(event, { kind: 'dashboard' });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    if (!outcome.duplicate) await this.publish(outcome.events);
    return outcome.event.seq;
  }

  heartbeat(sessionId = this.state.sessionId): void {
    const outcome = this.core.heartbeat(sessionId);
    if (outcome?.ok && !outcome.duplicate) void this.publish(outcome.events);
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

  private async handle(
    message: import('@agentigram/protocol').ClientMessage,
    peer: AuthorityPeer,
  ): Promise<ServerMessage[]> {
    if (message.type === 'HELLO') return this.core.welcome(message.client, message.lastSeq);
    if (message.type === 'HEARTBEAT') {
      const sessionId = peer.sessionId ?? message.sessionId;
      const outcome = sessionId ? this.core.heartbeat(sessionId) : undefined;
      if (outcome?.ok && !outcome.duplicate) await this.publish(outcome.events);
      return [];
    }
    const outcome = this.core.submit(message.event, {
      kind: peer.client ?? 'daemon',
      ...(peer.sessionId ? { sessionId: peer.sessionId } : {}),
    });
    if (!outcome.ok) {
      return [
        {
          type: 'ERROR',
          code: outcome.code,
          message: outcome.message,
          ...(outcome.id ? { id: outcome.id } : {}),
        },
      ];
    }
    if (!outcome.duplicate) await this.publish(outcome.events);
    return [{ type: 'ACK', id: outcome.event.id, seq: outcome.event.seq }];
  }

  private async expireLeases(): Promise<void> {
    const events = this.core.expireLeases();
    if (events.length > 0) await this.publish(events);
  }

  private async disconnect(peer: AuthorityPeer): Promise<void> {
    if (!peer.sessionId) return;
    const events = this.core.expireSessionLeases(peer.sessionId, 'disconnect');
    if (events.length > 0) await this.publish(events);
  }

  private async publish(events: Event[]): Promise<void> {
    await this.server.publish(events);
    for (const listener of this.eventListeners) listener(events);
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
