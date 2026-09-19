import {
  type Event,
  EventSchema,
  emptyRoomState,
  type RoomState,
  RoomStateSchema,
  ServerMessageSchema,
} from '@agentigram/protocol';
import { reduce } from '@agentigram/reducer';
import { z } from 'zod';

export const DEFAULT_COORDINATOR_URL = 'ws://localhost:8787';
export const MAX_EVENTS = 2_500;

export type StreamStatus = 'connecting' | 'live' | 'read-only' | 'reconnecting';
export type StreamState = {
  status: StreamStatus;
  source?: 'daemon' | 'coordinator';
  transport?: 'connecting' | 'connected' | 'read-only' | 'closed';
  events: Event[];
  roomState: RoomState;
  lastSeq: number;
  error?: string;
};

export function initialStream(roomId = 'unknown'): StreamState {
  return { status: 'connecting', events: [], roomState: emptyRoomState(roomId), lastSeq: 0 };
}

export function roomSocketUrl(base: string, teamId: string): string {
  return `${base.replace(/\/+$/, '')}/room/${encodeURIComponent(teamId)}`;
}

const DaemonSnapshotSchema = z.object({
  roomId: z.string(),
  transport: z.enum(['connecting', 'connected', 'read-only', 'closed']),
  roomState: RoomStateSchema,
  events: z.array(EventSchema),
});

export function localBridgeUrl(teamId: string): string {
  return `/api/rooms/${encodeURIComponent(teamId)}/stream`;
}

export function applyDaemonSnapshot(state: StreamState, raw: string): StreamState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...state, error: 'Dropped a non-JSON daemon snapshot.' };
  }
  const parsed = DaemonSnapshotSchema.safeParse(json);
  if (!parsed.success) return { ...state, error: 'Dropped an invalid daemon snapshot.' };
  const snapshot = parsed.data;
  const bySequence = new Map(state.events.map((event) => [event.seq, event]));
  for (const event of snapshot.events) bySequence.set(event.seq, event);
  const events = [...bySequence.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-MAX_EVENTS);
  return {
    status:
      snapshot.transport === 'connected'
        ? 'live'
        : snapshot.transport === 'read-only'
          ? 'read-only'
          : 'reconnecting',
    source: 'daemon',
    transport: snapshot.transport,
    events,
    roomState: snapshot.roomState,
    lastSeq: snapshot.roomState.lastSeq,
  };
}

export function replayRoom(
  roomId: string,
  events: Event[],
  throughSeq = Number.POSITIVE_INFINITY,
): RoomState {
  return events
    .filter((event) => event.seq <= throughSeq)
    .sort((left, right) => left.seq - right.seq)
    .reduce((state, event) => reduce(state, event).state, emptyRoomState(roomId));
}

export function applyFrame(state: StreamState, raw: string): StreamState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...state, error: 'Dropped a non-JSON coordinator frame.' };
  }
  const parsed = ServerMessageSchema.safeParse(json);
  if (!parsed.success) return { ...state, error: 'Dropped an invalid coordinator frame.' };
  const message = parsed.data;
  switch (message.type) {
    case 'EVENTS': {
      const fresh = message.events
        .filter((event) => event.seq > state.lastSeq)
        .sort((left, right) => left.seq - right.seq);
      if (fresh.length === 0) return state;
      const events = [...state.events, ...fresh].slice(-MAX_EVENTS);
      const roomState = fresh.reduce(
        (current, event) => reduce(current, event).state,
        state.roomState,
      );
      return {
        status: 'live',
        source: 'coordinator',
        events,
        roomState,
        lastSeq: fresh.at(-1)?.seq ?? state.lastSeq,
      };
    }
    case 'WELCOME':
      return {
        ...state,
        status: 'live',
        source: 'coordinator',
        roomState: message.roomState,
      };
    case 'ERROR':
      return { ...state, error: `${message.code}: ${message.message}` };
    case 'ACK':
      return state;
  }
}
