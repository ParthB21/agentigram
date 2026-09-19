import type { Event, RoomState, SessionInfo, TeamSummary } from '@clankergram/protocol';
import type { Effect } from './effects.js';

export type ReduceResult = { state: RoomState; effects: Effect[] };

/**
 * Pure: (RoomState, Event) -> { state, effects }. No clocks, randomness, network or storage.
 * Time and ids come in on the event; side effects are returned for the coordinator.
 *
 * Implemented at M0: session lifecycle, heartbeat, intent, dashboard broadcast.
 * Leases, collisions, negotiation and agent routing are TODO stubs (see reduce.todo.test.ts).
 */
export function reduce(state: RoomState, event: Event): ReduceResult {
  // Replaying an already-applied seq is a no-op, so replay from any offset is safe.
  if (event.seq <= state.lastSeq) return { state, effects: [] };

  const next = applyEvent(state, event);
  const withSummary: RoomState = { ...next, lastSeq: event.seq, teamSummary: summarise(next) };

  const effects: Effect[] = [
    { kind: 'broadcast', to: 'dashboards', event },
    { kind: 'persist_batch', events: [event] },
  ];
  return { state: withSummary, effects };
}

function applyEvent(state: RoomState, event: Event): RoomState {
  const p = event.payload;
  switch (p.type) {
    case 'SESSION_STARTED': {
      const session: SessionInfo = {
        sessionId: p.sessionId,
        engineerId: event.actor.engineerId,
        host: p.host,
        model: p.model,
        ...(p.provider ? { provider: p.provider } : {}),
        branch: p.branch,
        ...(p.role ? { role: p.role } : {}),
        ...(p.task ? { task: p.task } : {}),
        status: 'active',
        startedAt: event.ts,
        lastHeartbeatAt: event.ts,
      };
      return { ...state, sessions: { ...state.sessions, [p.sessionId]: session } };
    }
    case 'SESSION_ENDED':
      return updateSession(state, p.sessionId, (s) => ({
        ...s,
        status: 'ended',
        endedAt: event.ts,
      }));
    case 'HEARTBEAT':
      return updateSession(state, p.sessionId, (s) =>
        s.status === 'ended'
          ? s
          : { ...s, lastHeartbeatAt: event.ts, status: s.status === 'idle' ? 'active' : s.status },
      );
    case 'INTENT': {
      const sessionId = event.actor.sessionId;
      if (!sessionId) return state;
      return updateSession(state, sessionId, (s) => ({
        ...s,
        intent: { task: p.task, files: p.files, symbols: p.symbols },
      }));
    }
    default:
      // TODO(part 1): leases, collisions, negotiation, contracts, markets, routing.
      return state;
  }
}

function updateSession(
  state: RoomState,
  sessionId: string,
  fn: (s: SessionInfo) => SessionInfo,
): RoomState {
  const current = state.sessions[sessionId];
  if (!current) return state; // unknown session: ignore rather than invent one
  return { ...state, sessions: { ...state.sessions, [sessionId]: fn(current) } };
}

function summarise(state: RoomState): TeamSummary {
  const sessions = Object.values(state.sessions);
  return {
    sessions: sessions.length,
    activeSessions: sessions.filter((s) => s.status !== 'ended').length,
    openCollisions: Object.values(state.collisions).filter((c) => c.status === 'open').length,
    openNegotiations: Object.values(state.negotiations).filter(
      (n) => n.state !== 'Verified' && n.state !== 'Escalated',
    ).length,
    activeLeases: Object.keys(state.leases).length,
  };
}
