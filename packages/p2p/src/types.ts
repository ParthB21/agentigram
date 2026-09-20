import type {
  ClientKind,
  ClientMessage,
  Event,
  NewEvent,
  RoomState,
  ServerMessage,
} from '@agentigram/protocol';

export type AuthorityPeer = {
  id: string;
  client?: ClientKind;
  sessionId?: string;
};

export type AuthorityHandler = (
  message: ClientMessage,
  peer: AuthorityPeer,
) => Promise<ServerMessage[]> | ServerMessage[];

export type TransportStatus = 'connecting' | 'connected' | 'read-only' | 'closed';

export interface RoomTransport {
  readonly status: TransportStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  submit(event: NewEvent): Promise<number>;
  heartbeat(sessionId?: string): void;
  onEvents(listener: (events: Event[]) => void): () => void;
  onWelcome(listener: (state: RoomState) => void): () => void;
  onStatus(listener: (status: TransportStatus) => void): () => void;
}

/** One block of the replicated log, as stored. */
export type CoreBlock = { index: number; raw: string };

/**
 * A window onto the Hypercore underneath a room.
 *
 * Corestore takes an exclusive lock on its storage, so nothing outside the
 * daemon can open the same core while it is running — the log has to be read
 * through whoever already holds it.
 */
export type CoreLog = {
  key: string;
  length: number;
  byteLength: number;
  /** True only on the authority; every peer holds a verified read-only replica. */
  writable: boolean;
  blocks: CoreBlock[];
};

/** Transports that can expose the log they replicate. */
export interface CoreLogReader {
  readCoreLog(limit?: number): Promise<CoreLog>;
}
