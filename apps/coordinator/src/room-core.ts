import {
  type ClientKind,
  type ErrorCode,
  type Event,
  emptyRoomState,
  type NewEvent,
  NewEventSchema,
  type RoomState,
  type ServerMessage,
} from '@agentigram/protocol';
import { type Effect, type Presence, presenceMap, reduce } from '@agentigram/reducer';
import { authorizeSubmit, type Origin } from './authz.js';
import { canSee } from './routing.js';
import type { EventStore } from './store.js';

export const MAX_EVENT_BYTES = 64 * 1024;
export const SNAPSHOT_EVERY = 100;
export const REPLAY_BATCH = 200;
export const HEARTBEAT_LOG_MS = 10_000;

export type CoreOptions = {
  now?: () => number;
  snapshotEvery?: number;
  replayBatch?: number;
};

export type SubmitOutcome =
  | { ok: true; event: Event; events: Event[]; duplicate: boolean; effects: Effect[] }
  | { ok: false; code: ErrorCode; message: string; id?: string };

/**
 * The room, minus the transport: assigns `seq`, dedupes by client id, authorises, runs the pure
 * reducer, persists, and answers HELLO. The Durable Object is a thin adapter over this, and this
 * is what the tests drive. Every input is untrusted (CLAUDE.md rule 2).
 */
export class RoomCore {
  private state: RoomState;
  private lastTs = 0;
  private readonly now: () => number;
  private readonly snapshotEvery: number;
  private readonly replayBatch: number;

  constructor(
    readonly roomId: string,
    private readonly store: EventStore,
    options: CoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.snapshotEvery = options.snapshotEvery ?? SNAPSHOT_EVERY;
    this.replayBatch = options.replayBatch ?? REPLAY_BATCH;
    this.state = this.hydrate();
  }

  get head(): number {
    return this.state.lastSeq;
  }

  get currentState(): RoomState {
    return structuredClone(this.state);
  }

  /** Snapshot + replay: the state a room wakes up with. */
  private hydrate(): RoomState {
    const snap = this.store.loadSnapshot();
    let state =
      snap && snap.state.roomId === this.roomId ? snap.state : emptyRoomState(this.roomId);
    let from = state === snap?.state ? snap.seq : 0;
    for (;;) {
      const batch = this.store.after(from, this.replayBatch);
      if (batch.length === 0) break;
      for (const event of batch) {
        state = reduce(state, event).state;
        this.lastTs = Math.max(this.lastTs, Date.parse(event.ts) || 0);
      }
      from = batch[batch.length - 1]?.seq ?? from;
    }
    return state;
  }

  submit(input: unknown, origin: Origin): SubmitOutcome {
    const id = (input as { event?: { id?: unknown }; id?: unknown } | null)?.id;
    const idHint = typeof id === 'string' ? id : undefined;
    const fail = (code: ErrorCode, message: string): SubmitOutcome => ({
      ok: false,
      code,
      message,
      ...(idHint ? { id: idHint } : {}),
    });

    if (JSON.stringify(input ?? null).length > MAX_EVENT_BYTES) {
      return fail('BAD_MESSAGE', `event exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    const parsed = NewEventSchema.safeParse(input);
    if (!parsed.success)
      return fail('BAD_MESSAGE', parsed.error.issues[0]?.message ?? 'invalid event');
    const incoming = parsed.data;
    if (incoming.roomId !== this.roomId)
      return fail('ROOM_MISMATCH', `this is room ${this.roomId}`);

    const verdict = authorizeSubmit(origin, incoming);
    if (!verdict.ok) return fail('UNAUTHORIZED', verdict.reason);

    // At-least-once in, exactly-once applied: a retry gets the original event back.
    const prior = this.store.getById(incoming.id);
    if (prior) return { ok: true, event: prior, events: [prior], duplicate: true, effects: [] };

    const fencingError = this.validateFencing(incoming, origin);
    if (fencingError) return fail('UNAUTHORIZED', fencingError);

    const before = this.state;
    const primary = this.append(incoming);
    const event = primary.event;
    const events = [event];
    const effects = [...primary.effects];
    for (const derived of this.derive(event, before, origin)) {
      const applied = this.append(derived);
      events.push(applied.event);
      effects.push(...applied.effects);
    }
    return { ok: true, event, events, duplicate: false, effects };
  }

  /** Authority-side expiry. Call from a Durable Object alarm or the local authority timer. */
  expireLeases(at = this.now()): Event[] {
    const expired = Object.values(this.state.leases).filter(
      (lease) => Date.parse(lease.expiresAt) <= at,
    );
    return expired.map(
      (lease) =>
        this.append({
          id: `lease-expired:${lease.leaseId}:${at}`,
          roomId: this.roomId,
          actor: { engineerId: 'authority', kind: 'system' },
          source: 'system',
          payload: { type: 'LEASE_EXPIRED', leaseId: lease.leaseId, reason: 'ttl' },
        }).event,
    );
  }

  expireSessionLeases(sessionId: string, reason: 'disconnect' | 'overridden'): Event[] {
    return Object.values(this.state.leases)
      .filter((lease) => lease.sessionId === sessionId)
      .map(
        (lease) =>
          this.append({
            id: `lease-expired:${lease.leaseId}:${reason}:${this.now()}`,
            roomId: this.roomId,
            actor: { engineerId: 'authority', kind: 'system' },
            source: 'system',
            payload: { type: 'LEASE_EXPIRED', leaseId: lease.leaseId, reason },
          }).event,
      );
  }

  /** WELCOME plus the gap after `lastSeq` (batched), filtered for what `kind` may see. */
  welcome(kind: ClientKind, lastSeq: number): ServerMessage[] {
    const from = lastSeq > this.state.lastSeq ? 0 : lastSeq; // a client ahead of head saw another history
    const out: ServerMessage[] = [
      { type: 'WELCOME', roomState: this.stateFor(kind), fromSeq: from },
    ];
    let cursor = from;
    for (;;) {
      const batch = this.store.after(cursor, this.replayBatch);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]?.seq ?? cursor;
      const visible = batch.filter((e) => canSee(kind, e));
      if (visible.length > 0) out.push({ type: 'EVENTS', events: visible });
    }
    return out;
  }

  /** Agents never see markets (rule 5), so their copy of the state has none. */
  stateFor(kind: ClientKind): RoomState {
    return kind === 'dashboard' ? this.state : { ...this.state, markets: {} };
  }

  /**
   * A wire HEARTBEAT from a daemon. Presence must be replayable and visible to dashboards, so it
   * becomes a logged HEARTBEAT event, throttled to one per session per HEARTBEAT_LOG_MS.
   */
  heartbeat(sessionId: string): SubmitOutcome | undefined {
    const session = this.state.sessions[sessionId];
    if (!session || session.status === 'ended') return undefined;
    if (this.now() - (Date.parse(session.lastHeartbeatAt) || 0) < HEARTBEAT_LOG_MS)
      return undefined;
    return this.submit(
      {
        id: crypto.randomUUID(),
        roomId: this.roomId,
        actor: { engineerId: session.engineerId, sessionId, kind: 'agent' },
        source: 'system',
        payload: { type: 'HEARTBEAT', sessionId },
      },
      { kind: 'system' },
    );
  }

  presence(): Record<string, Presence> {
    return presenceMap(this.state, this.now());
  }

  eventsAfter(seq: number, limit?: number): Event[] {
    return this.store.after(seq, limit);
  }

  private append(input: NewEvent): { event: Event; effects: Effect[] } {
    this.lastTs = Math.max(this.lastTs + 1, this.now());
    const event: Event = {
      ...input,
      seq: this.state.lastSeq + 1,
      ts: new Date(this.lastTs).toISOString(),
    };
    const result = reduce(this.state, event);
    this.store.append(event);
    this.state = result.state;
    if (event.seq % this.snapshotEvery === 0) this.store.saveSnapshot(event.seq, result.state);
    return { event, effects: result.effects };
  }

  private derive(event: Event, before: RoomState, origin: Origin): NewEvent[] {
    if (origin.kind === 'system') return [];
    if (event.payload.type === 'LEASE_REQUESTED') {
      const payload = event.payload;
      const sessionId = event.actor.sessionId;
      if (!sessionId) return [];
      const held = Object.values(before.leases).find((lease) =>
        lease.symbols.some((symbol) => payload.symbols.includes(symbol)),
      );
      if (held) {
        return [
          {
            id: `${event.id}:denied`,
            roomId: this.roomId,
            actor: { engineerId: 'authority', kind: 'system' },
            causedBy: event.seq,
            source: 'system',
            payload: {
              type: 'LEASE_DENIED',
              symbols: payload.symbols,
              heldBy: held.sessionId,
              leaseId: held.leaseId,
              reason: 'one or more symbols are already leased',
            },
          },
        ];
      }
      const leaseId = `${this.roomId}:${event.seq}`;
      return [
        {
          id: `${event.id}:granted`,
          roomId: this.roomId,
          actor: { engineerId: 'authority', kind: 'system' },
          causedBy: event.seq,
          source: 'system',
          payload: {
            type: 'LEASE_GRANTED',
            leaseId,
            sessionId,
            symbols: payload.symbols,
            fencingToken: event.seq,
            expiresAt: new Date(Date.parse(event.ts) + payload.ttlMs).toISOString(),
            ttlMs: payload.ttlMs,
          },
        },
      ];
    }
    if (event.payload.type === 'SESSION_ENDED') {
      const payload = event.payload;
      return Object.values(before.leases)
        .filter((lease) => lease.sessionId === payload.sessionId)
        .map((lease) => ({
          id: `${event.id}:expired:${lease.leaseId}`,
          roomId: this.roomId,
          actor: { engineerId: 'authority', kind: 'system' as const },
          causedBy: event.seq,
          source: 'system' as const,
          payload: {
            type: 'LEASE_EXPIRED' as const,
            leaseId: lease.leaseId,
            reason: 'session_ended' as const,
          },
        }));
    }
    return [];
  }

  private validateFencing(event: NewEvent, origin: Origin): string | undefined {
    if (origin.kind === 'system') return undefined;
    if (event.payload.type !== 'FILE_WRITE') return undefined;
    const path = normalisePath(event.payload.path);
    const lease = Object.values(this.state.leases).find((candidate) =>
      candidate.symbols.some((symbol) => normalisePath(symbol.split('#')[0] ?? '') === path),
    );
    if (!lease) return undefined;
    if (event.actor.sessionId !== lease.sessionId) return `path is leased by ${lease.sessionId}`;
    if (event.payload.fencingToken !== lease.fencingToken) {
      return `stale fencing token for lease ${lease.leaseId}`;
    }
    return undefined;
  }
}

const normalisePath = (path: string): string => path.replaceAll('\\\\', '/').replace(/^\.\//, '');
