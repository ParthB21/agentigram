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
