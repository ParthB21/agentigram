import type { RoomState } from '@clankergram/protocol';

/** A session with no heartbeat for this long is stale (spec → Presence; Part 1 M1). */
export const STALE_AFTER_MS = 30_000;

export type Presence = 'live' | 'stale' | 'ended';

/**
 * Pure: the caller passes `nowMs` (the reducer never reads a clock). `lastSeenMs` is the newest
 * signal from the connection itself (wire HEARTBEAT), which is not logged as an event.
 */
export function sessionPresence(
  state: RoomState,
  sessionId: string,
  nowMs: number,
  lastSeenMs?: number,
  staleAfterMs = STALE_AFTER_MS,
): Presence | undefined {
  const s = state.sessions[sessionId];
  if (!s) return undefined;
  if (s.status === 'ended') return 'ended';
  const newest = Math.max(Date.parse(s.lastHeartbeatAt) || 0, lastSeenMs ?? 0);
  return nowMs - newest > staleAfterMs ? 'stale' : 'live';
}

export function presenceMap(
  state: RoomState,
  nowMs: number,
  lastSeen: ReadonlyMap<string, number> = new Map(),
): Record<string, Presence> {
  const out: Record<string, Presence> = {};
  for (const id of Object.keys(state.sessions)) {
    const p = sessionPresence(state, id, nowMs, lastSeen.get(id));
    if (p) out[id] = p;
  }
  return out;
}
