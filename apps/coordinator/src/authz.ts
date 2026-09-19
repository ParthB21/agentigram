import type { ClientKind, NewEvent, PayloadType } from '@agentigram/protocol';

/** Who is submitting. `system` is the coordinator itself (alarms, tests) and bypasses authz. */
export type Origin = { kind: ClientKind | 'system'; sessionId?: string };

/** Only the coordinator may create these; a daemon claiming them is forging coordination state. */
const COORDINATOR_ONLY: ReadonlySet<PayloadType> = new Set([
  'LEASE_GRANTED',
  'LEASE_DENIED',
  'LEASE_EXPIRED',
  'RUN_VERIFIED',
  'PERSONA_LINES',
  'MARKET_CLOSED',
  'MARKET_RESOLVED',
  'MARKET_VOIDED',
]);

/** Server-side results workers may post over HTTP ingest (spec → Interfaces between parts). */
export const WORKER_TYPES: ReadonlySet<PayloadType> = new Set([
  'SPEC_MERGE_RESULT',
  'CI_RESULT',
  'REVIEW_RESULT',
  'CONTRACT_RESULT',
  'CONTRACT_COMPILED',
  'COLLISION',
]);

/** Human actions from the dashboard: trades, lease override, escalation decisions. */
const DASHBOARD_TYPES: ReadonlySet<PayloadType> = new Set([
  'TRADE',
  'MARKET_OPENED',
  'LEASE_RELEASED',
  'ACCEPT',
  'ESCALATE',
  'TASK_CREATED',
]);

export type Verdict = { ok: true } | { ok: false; reason: string };

export function authorizeSubmit(origin: Origin, event: NewEvent): Verdict {
  if (origin.kind === 'system') return { ok: true };
  const type = event.payload.type;

  if (origin.kind === 'worker') {
    if (!WORKER_TYPES.has(type)) return { ok: false, reason: `workers may not submit ${type}` };
    if (event.actor.kind !== 'system')
      return { ok: false, reason: 'worker events must be system-actor' };
    return { ok: true };
  }
  if (origin.kind === 'dashboard') {
    if (!DASHBOARD_TYPES.has(type))
      return { ok: false, reason: `dashboards may not submit ${type}` };
    if (event.actor.kind !== 'human')
      return { ok: false, reason: 'dashboard events must be human-actor' };
    return { ok: true };
  }
  // daemon
  if (COORDINATOR_ONLY.has(type) || (WORKER_TYPES.has(type) && type !== 'COLLISION')) {
    return { ok: false, reason: `daemons may not submit ${type}` };
  }
  if (event.actor.kind === 'system') return { ok: false, reason: 'daemons may not act as system' };
  // A daemon stamps its own liveness beat `system`; no other coordinator-side source is allowed.
  const ownHeartbeat = type === 'HEARTBEAT' && event.source === 'system';
  if (!ownHeartbeat && (event.source === 'system' || event.source === 'github')) {
    return { ok: false, reason: `daemons may not use source ${event.source}` };
  }
  if (type === 'TRADE' || type === 'MARKET_OPENED') {
    return { ok: false, reason: 'markets are dashboard-only; agents cannot trade' };
  }
  // A daemon that announced a session in HELLO may only speak for that session.
  if (origin.sessionId && event.actor.sessionId && event.actor.sessionId !== origin.sessionId) {
    return { ok: false, reason: 'actor.sessionId does not match the connection' };
  }
  return { ok: true };
}

/** Constant-time string compare, so a secret is not recoverable by timing. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Stub auth (M1): the HELLO token must equal the room secret. Real JWT auth is M3. */
export function checkToken(token: string, secret: string | undefined): boolean {
  return !!secret && safeEqual(token, secret);
}
