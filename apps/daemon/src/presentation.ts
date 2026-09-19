import { redactPayload, redactSecrets } from '@agentigram/adapters';
import type { Event } from '@agentigram/protocol';

const MAX_PRESENTATION_EVENTS = 8;
const MAX_TEXT = 240;
const IMPORTANT_TYPES = new Set([
  'BLOCKER',
  'COLLISION',
  'LEASE_DENIED',
  'PROPOSAL',
  'COUNTER',
  'ACCEPT',
  'ESCALATE',
  'CONTRACT_COMPILED',
  'CONTRACT_RESULT',
  'SPEC_MERGE_RESULT',
  'RUN_VERIFIED',
]);

export type PresentationFact = string | number | boolean | string[];

export type PresentationEvent = {
  seq: number;
  sourceSeqs: number[];
  ts: string;
  type: string;
  actor: string;
  facts: Record<string, PresentationFact>;
  fallback: string;
};

/**
 * Produces the only event shape exposed to the local QVAC presentation app.
 * Coordination truth stays in RoomState; this is a bounded, redacted projection.
 */
export function presentationWindow(
  events: Event[],
  afterSeq: number,
  limit = MAX_PRESENTATION_EVENTS,
): PresentationEvent[] {
  return events
    .filter((event) => event.seq > afterSeq && IMPORTANT_TYPES.has(event.payload.type))
    .sort((left, right) => left.seq - right.seq)
    .slice(-Math.max(1, Math.min(limit, MAX_PRESENTATION_EVENTS)))
    .map(toPresentationEvent);
}

export function toPresentationEvent(event: Event): PresentationEvent {
  const payload = redactPayload(event.payload, { catchAll: true });
  const actor = clean(event.actor.sessionId ?? event.actor.engineerId);
  const sourceSeqs = [...new Set([event.causedBy, event.seq].filter(isSequence))].sort(
    (left, right) => left - right,
  );
  const facts: Record<string, PresentationFact> = {};
  let fallback: string;

  switch (payload.type) {
    case 'COLLISION':
      Object.assign(facts, {
        collisionId: clean(payload.collisionId),
        tier: payload.tier,
        symbols: payload.symbols.slice(0, 12).map(clean),
        writerSession: clean(payload.writerSession),
        affectedSessions: payload.affectedSessions.slice(0, 12).map(clean),
        detail: clean(payload.detail),
        ...(payload.confidence === undefined ? {} : { confidence: payload.confidence }),
      });
      fallback = `${payload.tier.toLowerCase().replaceAll('_', ' ')} collision: ${clean(payload.detail)}`;
      break;
    case 'LEASE_DENIED':
      Object.assign(facts, {
        symbols: payload.symbols.slice(0, 12).map(clean),
        heldBy: clean(payload.heldBy),
        reason: clean(payload.reason),
      });
      fallback = `Edit blocked because ${clean(payload.heldBy)} holds the active lease: ${clean(payload.reason)}`;
      break;
    case 'PROPOSAL':
    case 'COUNTER':
      Object.assign(facts, {
        collisionId: clean(payload.collisionId),
        symbol: clean(payload.contract.symbol),
        contractKind: payload.contract.kind,
        before: clean(payload.contract.before),
        after: clean(payload.contract.after),
        ...(payload.type === 'COUNTER' ? { reason: clean(payload.reason) } : {}),
      });
      fallback =
        payload.type === 'COUNTER'
          ? `Contract counter-proposal for ${clean(payload.contract.symbol)}: ${clean(payload.reason)}`
          : `Contract proposed for ${clean(payload.contract.symbol)}.`;
      break;
    case 'ACCEPT':
      facts.collisionId = clean(payload.collisionId);
      fallback = `The contract for collision ${clean(payload.collisionId)} was accepted.`;
      break;
    case 'ESCALATE':
      Object.assign(facts, {
        collisionId: clean(payload.collisionId),
        reason: clean(payload.reason),
      });
      fallback = `Human decision requested: ${clean(payload.reason)}`;
      break;
    case 'CONTRACT_COMPILED':
      Object.assign(facts, {
        contractId: clean(payload.contractId),
        checkFiles: payload.checkFiles.slice(0, 12).map((file) => clean(file.path)),
      });
      fallback = `Contract ${clean(payload.contractId)} compiled into ${payload.checkFiles.length} check file(s).`;
      break;
    case 'CONTRACT_RESULT':
      Object.assign(facts, {
        contractId: clean(payload.contractId),
        status: payload.status,
        ...(payload.detail ? { detail: clean(payload.detail) } : {}),
      });
      fallback = `Contract ${clean(payload.contractId)} ${payload.status === 'pass' ? 'passed' : 'failed'}${payload.detail ? `: ${clean(payload.detail)}` : '.'}`;
      break;
    case 'SPEC_MERGE_RESULT': {
      const cleanMerge = payload.typeErrors.length === 0 && payload.failingTests.length === 0;
      Object.assign(facts, {
        sessions: payload.sessions.slice(0, 12).map(clean),
        typeErrorCount: payload.typeErrors.length,
        failingTests: payload.failingTests.slice(0, 12).map(clean),
        notRun: payload.notRun.slice(0, 12).map(clean),
        clean: cleanMerge,
      });
      fallback = cleanMerge
        ? 'The speculative merge completed successfully with no type errors or failing tests.'
        : `The speculative merge found ${payload.typeErrors.length} type error(s) and ${payload.failingTests.length} failing test(s).`;
      break;
    }
    case 'RUN_VERIFIED':
      Object.assign(facts, {
        runId: clean(payload.runId),
        sessionId: clean(payload.sessionId),
        ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
      });
      fallback = `Run ${clean(payload.runId)} was verified successfully.`;
      break;
    case 'BLOCKER':
      facts.text = clean(payload.text);
      fallback = `Work is blocked: ${clean(payload.text)}`;
      break;
    default:
      fallback = payload.type.toLowerCase().replaceAll('_', ' ');
  }

  return {
    seq: event.seq,
    sourceSeqs,
    ts: event.ts,
    type: payload.type,
    actor,
    facts,
    fallback: clean(fallback),
  };
}

function clean(value: unknown): string {
  return redactSecrets(value, { catchAll: true }).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function isSequence(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? -1) >= 0;
}
