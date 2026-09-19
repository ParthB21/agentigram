import { type ClientKind, type Event, isAgentVisible } from '@clankergram/protocol';

/** A connection as the router sees it. `id` is opaque (a socket tag). */
export type Client = { id: string; kind: ClientKind; sessionId?: string };

export function canSee(kind: ClientKind, event: Event): boolean {
  return kind === 'dashboard' || isAgentVisible(event.payload.type);
}

/**
 * Who receives a freshly applied event. Dashboards get everything; daemons and workers get
 * only agent-visible events. Never returns a non-dashboard client for a dashboard-only type.
 *
 * M1 placeholder: every agent-visible event goes to every daemon. M2 replaces this with
 * symbol-fact vs directed-event routing (packages/reducer), keeping the visibility guard.
 */
export function recipients(event: Event, clients: readonly Client[]): Client[] {
  return clients.filter((c) => canSee(c.kind, event));
}
