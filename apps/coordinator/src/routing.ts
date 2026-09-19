import { type ClientKind, type Event, isAgentVisible, type RoomState } from '@agentigram/protocol';
import { routeEvent } from '@agentigram/reducer';

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
export function recipients(event: Event, clients: readonly Client[], state?: RoomState): Client[] {
  const routed = state ? new Set(routeEvent(state, event)) : undefined;
  return clients.filter((client) => {
    if (!canSee(client.kind, event)) return false;
    if (client.kind !== 'daemon' || !client.sessionId || !routed) return true;
    return routed.has(client.sessionId);
  });
}
