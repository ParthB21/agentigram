import {
  type Event,
  emptyRoomState,
  type RoomState,
  ServerMessageSchema,
} from '@clankergram/protocol';
import { reduce } from '@clankergram/reducer';

export const DEFAULT_COORDINATOR_URL = 'ws://localhost:8787';
export const MAX_EVENTS = 2_500;

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';
export type StreamState = {
  status: StreamStatus;
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
        events,
        roomState,
        lastSeq: fresh.at(-1)?.seq ?? state.lastSeq,
      };
    }
    case 'WELCOME':
      return {
        ...state,
        status: 'live',
        roomState: message.roomState,
      };
    case 'ERROR':
      return { ...state, error: `${message.code}: ${message.message}` };
    case 'ACK':
      return state;
  }
}
