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
import { detectCollisions } from './collide.js';
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
  private announcing = false;
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

  /** The log this room is built from, read through the lock this process holds. */
  readCoreLog(limit?: number) {
    return this.server.readCoreLog(limit);
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

  /**
   * Submit as the coordinator itself, which is what this process is. Reserved
   * for the types authz marks coordinator-authored — `COLLISION`, which this
   * transport detects, and `PERSONA_LINES`, which carries locally rendered
   * dialogue. A daemon submitting either over the wire is forging coordination
   * state and is rejected; doing it here is the authority speaking as itself.
   */
  async submitAsAuthority(event: NewEvent): Promise<number> {
    const outcome = this.core.submit(event, { kind: 'system' });
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
    const events = [
      ...this.core.expireSessionLeases(peer.sessionId, 'disconnect'),
      ...this.core.endSession(peer.sessionId, 'disconnect'),
    ];
    if (events.length > 0) await this.publish(events);
  }

  private async publish(events: Event[]): Promise<void> {
    await this.server.publish(events);
    for (const listener of this.eventListeners) listener(events);
    await this.announceCollisions(events);
  }

  /**
   * Tier 0/1 detection (`collide.ts`), run here because this is the single
   * writer: every event the room agrees on passes through `publish`, so a
   * collision is opened exactly once no matter which laptop provoked it or
   * which process is driving the authority.
   */
  private async announceCollisions(events: Event[]): Promise<void> {
    // A COLLISION is itself published, which re-enters here. It can never
    // produce a further collision, but the guard keeps that a fact about this
    // method rather than about `detectCollisions`.
    if (this.announcing) return;

    const state = this.core.stateFor('daemon');
    const candidates = new Map<string, ReturnType<typeof detectCollisions>[number]>();
    for (const event of events) {
      for (const candidate of detectCollisions(state, event)) {
        // One state snapshot covers the whole batch, so two events in it can
        // find the same overlap; the first wins.
        if (!candidates.has(candidate.collisionId)) candidates.set(candidate.collisionId, candidate);
      }
    }
    if (candidates.size === 0) return;

    this.announcing = true;
    try {
      for (const candidate of candidates.values()) {
        await this.submitAsAuthority({
          id: crypto.randomUUID(),
          roomId: this.state.roomId,
          actor: { engineerId: this.state.engineerId, kind: 'system' },
          source: 'system',
          payload: { type: 'COLLISION', ...candidate },
        });
      }
    } finally {
      this.announcing = false;
    }
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
