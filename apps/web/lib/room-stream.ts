import { type Event, ServerMessageSchema } from '@clankergram/protocol';

export const DEFAULT_COORDINATOR_URL = 'ws://localhost:8787';
/** Keep the raw view bounded; the timeline page (Part 4) will page from history instead. */
export const MAX_EVENTS = 500;

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';
export type StreamState = {
  status: StreamStatus;
  events: Event[];
  lastSeq: number;
  error?: string;
};

export const initialStream: StreamState = { status: 'connecting', events: [], lastSeq: 0 };

export function roomSocketUrl(base: string, teamId: string): string {
  return `${base.replace(/\/+$/, '')}/room/${encodeURIComponent(teamId)}`;
}

/** Parses one frame from the coordinator; anything invalid is dropped (CLAUDE.md rule 2). */
export function applyFrame(state: StreamState, raw: string): StreamState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...state, error: 'dropped a non-JSON frame' };
  }
  const parsed = ServerMessageSchema.safeParse(json);
  if (!parsed.success) return { ...state, error: 'dropped an invalid frame' };
  const msg = parsed.data;
  switch (msg.type) {
    case 'EVENTS': {
      const fresh = msg.events.filter((e) => e.seq > state.lastSeq).sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0) return state;
      const events = [...state.events, ...fresh].slice(-MAX_EVENTS);
      return { status: 'live', events, lastSeq: fresh[fresh.length - 1]?.seq ?? state.lastSeq };
    }
    case 'WELCOME':
      return { ...state, status: 'live' };
    case 'ERROR':
      return { ...state, error: `${msg.code}: ${msg.message}` };
    case 'ACK':
      return state;
  }
}
