import { type Event, isAgentVisible, MAX_AUTOMATION_DEPTH } from '@agentigram/protocol';
import { STALE_EVENT_MAX_AGE_MS } from './cursor-store.js';
import { agentContextText } from './event-rendering.js';

export const MAX_INBOX_EVENTS = 20;
const ACTIONABLE_TYPES = new Set([
  'MESSAGE',
  'BLOCKER',
  'COLLISION',
  'LEASE_DENIED',
  'PROPOSAL',
  'COUNTER',
  'ACCEPT',
  'ESCALATE',
  'CONTEXT_PACKET',
  'CONTEXT_QUERY',
  'CONTEXT_ANSWER',
]);

export type InboxItem = {
  seq: number;
  eventId: string;
  from: string;
  eventType: Event['payload']['type'];
  text: string;
  conversationId: string;
  automationDepth: number;
};

export type InboxClaim = {
  claimId: string;
  sessionId: string;
  items: InboxItem[];
};

export function isFreshEvent(
  event: Event,
  now: number,
  maxAgeMs = STALE_EVENT_MAX_AGE_MS,
): boolean {
  const timestamp = Date.parse(event.ts);
  return Number.isFinite(timestamp) && now - timestamp <= maxAgeMs;
}

export function shouldRouteToInbox(
  event: Event,
  localSessionId: string,
  routedSessions: readonly string[],
  now: number,
): boolean {
  return (
    isFreshEvent(event, now) &&
    isAgentVisible(event.payload.type) &&
    ACTIONABLE_TYPES.has(event.payload.type) &&
    event.actor.sessionId !== localSessionId &&
    routedSessions.includes(localSessionId)
  );
}

export function shouldWake(
  event: Event,
  localSessionId: string,
  routedSessions: readonly string[],
  now: number,
): boolean {
  return (
    shouldRouteToInbox(event, localSessionId, routedSessions, now) &&
    (event.payload.type !== 'MESSAGE' ||
      (event.payload.automationDepth ?? 0) < MAX_AUTOMATION_DEPTH)
  );
}

type ClaimIdFactory = () => string;

export class WakeInbox {
  private readonly pending = new Map<string, InboxItem[]>();
  private readonly claims = new Map<string, InboxClaim>();

  constructor(private readonly newClaimId: ClaimIdFactory = () => crypto.randomUUID()) {}

  enqueue(sessionId: string, event: Event): InboxItem {
    const payload = event.payload;
    const item: InboxItem = {
      seq: event.seq,
      eventId: event.id,
      from: event.actor.sessionId ?? event.actor.engineerId,
      eventType: payload.type,
      text: agentContextText(event),
      conversationId: payload.type === 'MESSAGE' ? (payload.conversationId ?? event.id) : event.id,
      automationDepth: payload.type === 'MESSAGE' ? (payload.automationDepth ?? 0) : 0,
    };
    const current = this.pending.get(sessionId) ?? [];
    current.push(item);
    this.pending.set(sessionId, current.slice(-MAX_INBOX_EVENTS));
    return item;
  }

  claim(sessionId: string): InboxClaim | undefined {
    const current = this.pending.get(sessionId);
    const first = current?.[0];
    if (!current || !first) return undefined;
    const items = current.filter(
      (item) => item.from === first.from && item.conversationId === first.conversationId,
    );
    const selected = new Set(items.map((item) => item.seq));
    const remaining = current.filter((item) => !selected.has(item.seq));
    if (remaining.length > 0) this.pending.set(sessionId, remaining);
    else this.pending.delete(sessionId);
    const claim = { claimId: this.newClaimId(), sessionId, items };
    this.claims.set(claim.claimId, claim);
    return claim;
  }

  complete(sessionId: string, claimId: string): InboxClaim | undefined {
    const claim = this.claims.get(claimId);
    if (!claim || claim.sessionId !== sessionId) return undefined;
    this.claims.delete(claimId);
    return claim;
  }

  claimed(sessionId: string, claimId: string): InboxClaim | undefined {
    const claim = this.claims.get(claimId);
    return claim?.sessionId === sessionId ? claim : undefined;
  }

  requeue(sessionId: string, claimId: string): boolean {
    const claim = this.complete(sessionId, claimId);
    if (!claim) return false;
    const pending = this.pending.get(sessionId) ?? [];
    this.pending.set(sessionId, [...claim.items, ...pending]);
    return true;
  }

  consume(sessionId: string): InboxItem[] {
    const items = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    return items;
  }
}
