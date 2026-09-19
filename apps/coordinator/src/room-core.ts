import {
  type ClientKind,
  type ErrorCode,
  type Event,
  emptyRoomState,
  NewEventSchema,
  type RoomState,
  type ServerMessage,
} from '@clankergram/protocol';
import { type Effect, type Presence, presenceMap, reduce } from '@clankergram/reducer';
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
  | { ok: true; event: Event; duplicate: boolean; effects: Effect[] }
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
    if (prior) return { ok: true, event: prior, duplicate: true, effects: [] };

    this.lastTs = Math.max(this.lastTs, this.now());
    const event: Event = {
      ...incoming,
      seq: this.state.lastSeq + 1,
      ts: new Date(this.lastTs).toISOString(),
    };
    const { state, effects } = reduce(this.state, event);
    this.store.append(event); // persist first: if this throws, in-memory state is untouched
    this.state = state;
    if (event.seq % this.snapshotEvery === 0) this.store.saveSnapshot(event.seq, state);
    return { ok: true, event, duplicate: false, effects };
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
}
