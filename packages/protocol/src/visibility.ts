import { z } from 'zod';
import type { PayloadType } from './payloads.js';

/**
 * Dashboard-only payload types (CLAUDE.md rule 5). Agents never see persona dialogue or markets.
 * Ported idea: OpenAgents' `EventVisibility` levels, collapsed to the two audiences we have.
 */
export const DASHBOARD_ONLY_TYPES = [
  'MARKET_OPENED',
  'TRADE',
  'MARKET_CLOSED',
  'MARKET_RESOLVED',
  'MARKET_VOIDED',
  'PERSONA_LINES',
] as const satisfies readonly PayloadType[];

const DASHBOARD_ONLY = new Set<string>(DASHBOARD_ONLY_TYPES);

export function isAgentVisible(eventType: string): boolean {
  return !DASHBOARD_ONLY.has(eventType);
}

/**
 * Wildcard pattern match on event type, ported from OpenAgents `Event.matches_pattern`:
 * `*` matches everything, `PREFIX*` matches by prefix, anything else is an exact match.
 */
export function matchesEventPattern(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return eventType.startsWith(pattern.slice(0, -1));
  return eventType === pattern;
}

/** A client's interest in event types, e.g. `LEASE_*` or `COLLISION`. Ported from `EventSubscription`. */
export const SubscriptionSchema = z.object({
  subscriberId: z.string(),
  patterns: z.array(z.string().min(1)).min(1),
  audience: z.enum(['agent', 'dashboard']),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/**
 * Visibility comes first, pattern second (as in OpenAgents `EventSubscription.matches_event`),
 * so a wildcard subscription can never widen an agent's view to dashboard-only events.
 */
export function subscriptionMatches(sub: Subscription, eventType: string): boolean {
  if (sub.audience === 'agent' && !isAgentVisible(eventType)) return false;
  return sub.patterns.some((p) => matchesEventPattern(p, eventType));
}
