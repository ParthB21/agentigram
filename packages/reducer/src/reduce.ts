import type {
  CollisionState,
  Contract,
  Event,
  Lease,
  Negotiation,
  RoomState,
  SessionInfo,
  TeamSummary,
} from '@agentigram/protocol';
import type { Effect } from './effects.js';
import { routeEvent } from './routing.js';

export type ReduceResult = { state: RoomState; effects: Effect[] };

export const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
export const NEGOTIATION_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_NEGOTIATION_ROUNDS = 3;

/** Pure room-state transition. Time, sequence numbers, and identifiers come from the event. */
export function reduce(state: RoomState, event: Event): ReduceResult {
  if (event.seq <= state.lastSeq) return { state, effects: [] };

  const timed = escalateTimedOutNegotiations(state, event.ts);
  const next = applyEvent(timed, event);
  const withHead: RoomState = {
    ...next,
    lastSeq: event.seq,
    teamSummary: summarise(next),
  };
  const effects: Effect[] = [
    { kind: 'broadcast', to: 'dashboards', event },
    { kind: 'persist_batch', events: [event] },
  ];
  const recipients = routeEvent(withHead, event);
  if (recipients.length > 0) effects.push({ kind: 'broadcast', to: recipients, event });

  if (event.payload.type === 'LEASE_GRANTED') {
    effects.push({
      kind: 'schedule_alarm',
      at: event.payload.expiresAt,
      reason: 'lease expiry',
      leaseId: event.payload.leaseId,
    });
  }
  if (event.payload.type === 'COLLISION' && isTierTwo(event.payload.tier)) {
    effects.push({
      kind: 'request_spec_merge',
      sessions: unique([event.payload.writerSession, ...event.payload.affectedSessions]),
      reason: `verify ${event.payload.collisionId}`,
    });
  }
  if (event.payload.type === 'ACCEPT') {
    const negotiation = withHead.negotiations[event.payload.collisionId];
    if (negotiation?.state === 'Accepted' && negotiation.contract) {
      effects.push({
        kind: 'request_contract_compile',
        collisionId: event.payload.collisionId,
        contract: negotiation.contract,
      });
    }
  }
  return { state: withHead, effects };
}

function applyEvent(state: RoomState, event: Event): RoomState {
  const payload = event.payload;
  switch (payload.type) {
    case 'SESSION_STARTED': {
      const session: SessionInfo = {
        sessionId: payload.sessionId,
        engineerId: event.actor.engineerId,
        host: payload.host,
        model: payload.model,
        ...(payload.provider ? { provider: payload.provider } : {}),
        branch: payload.branch,
        ...(payload.role ? { role: payload.role } : {}),
        ...(payload.task ? { task: payload.task } : {}),
        status: 'active',
        readFiles: [],
        readSymbols: [],
        writeFiles: [],
        startedAt: event.ts,
        lastHeartbeatAt: event.ts,
      };
      return { ...state, sessions: { ...state.sessions, [payload.sessionId]: session } };
    }
    case 'SESSION_ENDED': {
      const ended = updateSession(state, payload.sessionId, (session) => ({
        ...session,
        status: 'ended',
        endedAt: event.ts,
      }));
      return removeSessionLeases(ended, payload.sessionId);
    }
    case 'HEARTBEAT': {
      const active = updateSession(state, payload.sessionId, (session) =>
        session.status === 'ended'
          ? session
          : {
              ...session,
              lastHeartbeatAt: event.ts,
              status: session.status === 'idle' ? 'active' : session.status,
            },
      );
      const leases = Object.fromEntries(
        Object.entries(active.leases).map(([id, lease]) => [
          id,
          lease.sessionId === payload.sessionId
            ? {
                ...lease,
                expiresAt: new Date(
                  Date.parse(event.ts) + (lease.ttlMs ?? DEFAULT_LEASE_TTL_MS),
                ).toISOString(),
              }
            : lease,
        ]),
      );
      return { ...active, leases };
    }
    case 'INTENT': {
      const sessionId = event.actor.sessionId;
      return sessionId
        ? updateSession(state, sessionId, (session) => ({
            ...session,
            intent: { task: payload.task, files: payload.files, symbols: payload.symbols },
          }))
        : state;
    }
    case 'FILE_READ': {
      const sessionId = event.actor.sessionId;
      return sessionId
        ? updateSession(state, sessionId, (session) => ({
            ...session,
            readFiles: unique([...(session.readFiles ?? []), payload.path]),
            readSymbols: unique([...(session.readSymbols ?? []), ...(payload.symbols ?? [])]),
          }))
        : state;
    }
    case 'FILE_WRITE':
      return applyFileWrite(state, event);
    case 'LEASE_GRANTED': {
      const sessionId = payload.sessionId ?? event.actor.sessionId;
      if (!sessionId) return state;
      const lease: Lease = {
        leaseId: payload.leaseId,
        sessionId,
        symbols: payload.symbols,
        fencingToken: payload.fencingToken,
        expiresAt: payload.expiresAt,
        ...(payload.ttlMs ? { ttlMs: payload.ttlMs } : {}),
      };
      return { ...state, leases: { ...state.leases, [payload.leaseId]: lease } };
    }
    case 'LEASE_RELEASED':
    case 'LEASE_EXPIRED':
      return withoutLease(state, payload.leaseId);
    case 'COLLISION':
      return openCollision(state, event, {
        collisionId: payload.collisionId,
        tier: payload.tier,
        symbols: payload.symbols,
        writerSession: payload.writerSession,
        affectedSessions: payload.affectedSessions,
        detail: payload.detail,
        status: 'open',
        openedSeq: event.seq,
      });
    case 'PROPOSAL':
      return transitionNegotiation(state, payload.collisionId, (negotiation) => ({
        ...negotiation,
        state: 'Proposed',
        contract: payload.contract,
        accepted: [],
      }));
    case 'COUNTER':
      return transitionNegotiation(state, payload.collisionId, (negotiation) => {
        const round = negotiation.round + 1;
        return {
          ...negotiation,
          state: round >= MAX_NEGOTIATION_ROUNDS ? 'Escalated' : 'Countered',
          round,
          contract: payload.contract,
          accepted: [],
        };
      });
    case 'ACCEPT':
      return acceptNegotiation(state, payload.collisionId, event);
    case 'ESCALATE':
      return transitionNegotiation(state, payload.collisionId, (negotiation) => ({
        ...negotiation,
        state: 'Escalated',
      }));
    case 'CONTRACT_COMPILED':
      return compileContract(state, payload.collisionId, payload.contractId);
    case 'SPEC_MERGE_RESULT':
      return applySpecMerge(
        state,
        payload.sessions,
        payload.typeErrors.length === 0 && payload.failingTests.length === 0,
      );
    default:
      return state;
  }
}

function applyFileWrite(state: RoomState, event: Event): RoomState {
  if (event.payload.type !== 'FILE_WRITE' || !event.actor.sessionId) return state;
  const payload = event.payload;
  const writerSession = event.actor.sessionId;
  let next = updateSession(state, writerSession, (session) => ({
    ...session,
    writeFiles: unique([...(session.writeFiles ?? []), payload.path]),
  }));
  const affected = Object.values(state.sessions)
    .filter(
      (session) =>
        session.sessionId !== writerSession &&
        session.status !== 'ended' &&
        [...(session.writeFiles ?? []), ...(session.intent?.files ?? [])].includes(payload.path),
    )
    .map((session) => session.sessionId);
  if (affected.length === 0) return next;
  next = openCollision(next, event, {
    collisionId: `file-overlap:${event.seq}`,
    tier: 'FILE_OVERLAP',
    symbols: [],
    writerSession,
    affectedSessions: affected,
    detail: `Concurrent writes to ${payload.path}`,
    status: 'open',
    openedSeq: event.seq,
  });
  return next;
}

function openCollision(state: RoomState, event: Event, collision: CollisionState): RoomState {
  if (state.collisions[collision.collisionId]) return state;
  const participants = unique([collision.writerSession, ...collision.affectedSessions]);
  const negotiation: Negotiation = {
    collisionId: collision.collisionId,
    state: 'Open',
    round: 0,
    participants,
    accepted: [],
    openedSeq: event.seq,
    deadlineAt: new Date(Date.parse(event.ts) + NEGOTIATION_TIMEOUT_MS).toISOString(),
  };
  return {
    ...state,
    collisions: { ...state.collisions, [collision.collisionId]: collision },
    negotiations: { ...state.negotiations, [collision.collisionId]: negotiation },
  };
}

function acceptNegotiation(state: RoomState, collisionId: string, event: Event): RoomState {
  return transitionNegotiation(state, collisionId, (negotiation) => {
    if (negotiation.state === 'Escalated' && event.actor.kind === 'human') {
      return { ...negotiation, state: 'Accepted', accepted: negotiation.participants };
    }
    const sessionId = event.actor.sessionId;
    if (!sessionId || !negotiation.participants.includes(sessionId)) return negotiation;
    const accepted = unique([...negotiation.accepted, sessionId]);
    return {
      ...negotiation,
      accepted,
      state:
        negotiation.contract && negotiation.participants.every((id) => accepted.includes(id))
          ? 'Accepted'
          : negotiation.state,
    };
  });
}

function compileContract(
  state: RoomState,
  collisionId: string | undefined,
  contractId: string,
): RoomState {
  if (!collisionId) return state;
  const negotiation = state.negotiations[collisionId];
  if (!negotiation?.contract || negotiation.state !== 'Accepted') return state;
  const contracts = Object.fromEntries(
    Object.entries(state.contracts).map(([id, entry]) => [
      id,
      entry.contract.symbol === negotiation.contract?.symbol && entry.status !== 'superseded'
        ? { ...entry, status: 'superseded' as const, supersededBy: contractId }
        : entry,
    ]),
  );
  return {
    ...transitionNegotiation(state, collisionId, (current) => ({
      ...current,
      state: 'Compiled',
    })),
    contracts: {
      ...contracts,
      [contractId]: {
        contractId,
        collisionId,
        contract: negotiation.contract,
        version: nextContractVersion(state, negotiation.contract),
        status: 'compiled',
      },
    },
  };
}

function applySpecMerge(state: RoomState, sessions: string[], passed: boolean): RoomState {
  if (!passed) return state;
  let negotiations = state.negotiations;
  let collisions = state.collisions;
  let contracts = state.contracts;
  for (const negotiation of Object.values(state.negotiations)) {
    if (
      negotiation.state !== 'Compiled' ||
      !negotiation.participants.every((participant) => sessions.includes(participant))
    ) {
      continue;
    }
    negotiations = {
      ...negotiations,
      [negotiation.collisionId]: { ...negotiation, state: 'Verified' },
    };
    const collision = collisions[negotiation.collisionId];
    if (collision) {
      collisions = {
        ...collisions,
        [collision.collisionId]: { ...collision, status: 'resolved' },
      };
    }
    for (const [id, contract] of Object.entries(contracts)) {
      if (contract.collisionId === negotiation.collisionId) {
        contracts = { ...contracts, [id]: { ...contract, status: 'verified' } };
      }
    }
  }
  return { ...state, negotiations, collisions, contracts };
}

function transitionNegotiation(
  state: RoomState,
  collisionId: string,
  transition: (negotiation: Negotiation) => Negotiation,
): RoomState {
  const current = state.negotiations[collisionId];
  if (!current) return state;
  return {
    ...state,
    negotiations: { ...state.negotiations, [collisionId]: transition(current) },
  };
}

function escalateTimedOutNegotiations(state: RoomState, now: string): RoomState {
  const at = Date.parse(now);
  let changed = false;
  const negotiations: Record<string, Negotiation> = {};
  for (const [id, negotiation] of Object.entries(state.negotiations)) {
    const deadline = negotiation.deadlineAt
      ? Date.parse(negotiation.deadlineAt)
      : Number.POSITIVE_INFINITY;
    if (!['Verified', 'Escalated'].includes(negotiation.state) && at >= deadline) {
      changed = true;
      negotiations[id] = { ...negotiation, state: 'Escalated' };
    } else {
      negotiations[id] = negotiation;
    }
  }
  return changed ? { ...state, negotiations } : state;
}

function removeSessionLeases(state: RoomState, sessionId: string): RoomState {
  return {
    ...state,
    leases: Object.fromEntries(
      Object.entries(state.leases).filter(([, lease]) => lease.sessionId !== sessionId),
    ),
  };
}

function withoutLease(state: RoomState, leaseId: string): RoomState {
  if (!state.leases[leaseId]) return state;
  const leases = { ...state.leases };
  delete leases[leaseId];
  return { ...state, leases };
}

function updateSession(
  state: RoomState,
  sessionId: string,
  update: (session: SessionInfo) => SessionInfo,
): RoomState {
  const current = state.sessions[sessionId];
  return current
    ? { ...state, sessions: { ...state.sessions, [sessionId]: update(current) } }
    : state;
}

function nextContractVersion(state: RoomState, contract: Contract): number {
  return (
    Math.max(
      0,
      ...Object.values(state.contracts)
        .filter((entry) => entry.contract.symbol === contract.symbol)
        .map((entry) => entry.version),
    ) + 1
  );
}

function summarise(state: RoomState): TeamSummary {
  const sessions = Object.values(state.sessions);
  return {
    sessions: sessions.length,
    activeSessions: sessions.filter((session) => session.status !== 'ended').length,
    openCollisions: Object.values(state.collisions).filter(
      (collision) => collision.status === 'open',
    ).length,
    openNegotiations: Object.values(state.negotiations).filter(
      (negotiation) => !['Verified', 'Escalated'].includes(negotiation.state),
    ).length,
    activeLeases: Object.keys(state.leases).length,
  };
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const isTierTwo = (tier: string): boolean => ['SEMANTIC', 'CONFIRMED', 'TEXTUAL'].includes(tier);
