import type { Duplex } from 'node:stream';
import { ClientMessageSchema, type Event, type ServerMessage } from '@agentigram/protocol';
import b4a from 'b4a';
import c from 'compact-encoding';
import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import { type ControlChannel, openControlChannel } from './channel.js';
import { createCapability, discoveryTopic, encodeInvite, type RoomInvite } from './invite.js';
import type { AuthorityHandler, AuthorityPeer, CoreBlock, CoreLog } from './types.js';

type PeerChannel = { peer: AuthorityPeer; channel: ControlChannel };

export type P2PRoomServerOptions = {
  roomId: string;
  repositoryFingerprint: string;
  storage: string;
  capability?: string;
  handle: AuthorityHandler;
  onDisconnect?(peer: AuthorityPeer): void | Promise<void>;
};

export class P2PRoomServer {
  private readonly store: Corestore;
  private readonly swarm = new Hyperswarm();
  private readonly capability: string;
  private readonly peers = new Map<string, PeerChannel>();
  private readonly eventCore;
  private inviteValue: RoomInvite | undefined;
  private stopping = false;

  constructor(private readonly options: P2PRoomServerOptions) {
    this.store = new Corestore(options.storage);
    this.capability = options.capability ?? createCapability();
    this.eventCore = this.store.get<string>({
      name: `room-${options.roomId}-events`,
      valueEncoding: c.string,
    });
  }

  get invite(): RoomInvite {
    if (!this.inviteValue) throw new Error('P2P authority has not started');
    return this.inviteValue;
  }

  get inviteUri(): string {
    return encodeInvite(this.invite);
  }

  get historyLength(): number {
    return this.eventCore.length;
  }

  async start(): Promise<RoomInvite> {
    await this.eventCore.ready();
    this.inviteValue = {
      version: 1,
      roomId: this.options.roomId,
      repositoryFingerprint: this.options.repositoryFingerprint,
      authorityPublicKey: b4a.toString(this.swarm.keyPair.publicKey, 'hex'),
      eventCoreKey: b4a.toString(this.eventCore.key, 'hex'),
      capability: this.capability,
    };
    this.swarm.on('connection', (socket, peerInfo) => {
      this.attach(socket, b4a.toString(peerInfo.publicKey, 'hex'));
    });
    await this.swarm
      .join(discoveryTopic(this.inviteValue), { server: true, client: false })
      .flushed();
    return this.inviteValue;
  }

/**
   * The newest blocks of the replicated log, read through the process that
   * already holds the Corestore lock.
   */
  async readCoreLog(limit = 20): Promise<CoreLog> {
    await this.eventCore.ready();
    const blocks: CoreBlock[] = [];
    const from = Math.max(0, this.eventCore.length - Math.max(1, limit));
    for (let index = from; index < this.eventCore.length; index += 1) {
      // A replica can be ahead on the tree but missing a block it has not pulled.
      const raw = await this.eventCore.get(index).catch(() => null);
      if (raw !== null) blocks.push({ index, raw });
    }
    return {
      key: b4a.toString(this.eventCore.key, 'hex'),
      length: this.eventCore.length,
      byteLength: this.eventCore.byteLength,
      writable: this.eventCore.writable,
      blocks,
    };
  }

  async publish(events: readonly Event[]): Promise<void> {
    if (events.length === 0) return;
    await this.eventCore.append(events.map((event) => JSON.stringify(event)));
    const frame = JSON.stringify({ type: 'EVENTS', events: [...events] } satisfies ServerMessage);
    for (const { channel } of this.peers.values()) channel.send(frame);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const { channel } of this.peers.values()) channel.close();
    this.peers.clear();
    await this.swarm.destroy();
    await this.store.close();
  }

  private attach(socket: Duplex, peerId: string): void {
    this.store.replicate(socket);
    const handshake = JSON.stringify({ capability: this.capability, peerId: 'authority' });
    const peer: AuthorityPeer = { id: peerId };
    const channel = openControlChannel(
      socket,
      handshake,
      (value, remoteHandshake) => void this.receive(value, remoteHandshake, peerId),
      () => {
        const disconnected = this.peers.get(peerId)?.peer;
        this.peers.delete(peerId);
        if (disconnected && !this.stopping) void this.options.onDisconnect?.(disconnected);
      },
    );
    this.peers.set(peerId, { peer, channel });
  }

  private async receive(value: string, remoteHandshake: string, peerId: string): Promise<void> {
    const connected = this.peers.get(peerId);
    if (!connected) return;
    let capability = '';
    try {
      capability = String(
        (JSON.parse(remoteHandshake) as { capability?: unknown }).capability ?? '',
      );
    } catch {
      connected.channel.close();
      return;
    }
    if (capability !== this.capability) {
      connected.channel.close();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      connected.channel.send(
        JSON.stringify({
          type: 'ERROR',
          code: 'BAD_MESSAGE',
          message: 'not JSON',
        } satisfies ServerMessage),
      );
      return;
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      connected.channel.send(
        JSON.stringify({
          type: 'ERROR',
          code: 'BAD_MESSAGE',
          message: parsed.error.issues[0]?.message ?? 'invalid message',
        } satisfies ServerMessage),
      );
      return;
    }
    if (parsed.data.type === 'HELLO') {
      connected.peer.client = parsed.data.client;
      connected.peer.sessionId = parsed.data.sessionId;
    }
    for (const response of await this.options.handle(parsed.data, connected.peer)) {
      connected.channel.send(JSON.stringify(response));
    }
  }
}
