import { type Event, EventSchema, type RoomState, RoomStateSchema } from '@clankergram/protocol';

/** Persistence the room core needs. Synchronous, because Durable Object SQLite is synchronous. */
export interface EventStore {
  getById(id: string): Event | undefined;
  /** Events with seq > `seq`, ascending, at most `limit`. */
  after(seq: number, limit?: number): Event[];
  lastSeq(): number;
  append(event: Event): void;
  saveSnapshot(seq: number, state: RoomState): void;
  loadSnapshot(): { seq: number; state: RoomState } | undefined;
}

export class MemoryEventStore implements EventStore {
  private readonly events: Event[] = [];
  private readonly byId = new Map<string, Event>();
  private snapshot: { seq: number; state: RoomState } | undefined;

  getById(id: string) {
    return this.byId.get(id);
  }
  after(seq: number, limit = Number.POSITIVE_INFINITY) {
    return this.events.filter((e) => e.seq > seq).slice(0, limit);
  }
  lastSeq() {
    return this.events.at(-1)?.seq ?? 0;
  }
  append(event: Event) {
    this.events.push(event);
    this.byId.set(event.id, event);
  }
  saveSnapshot(seq: number, state: RoomState) {
    this.snapshot = { seq, state: structuredClone(state) };
  }
  loadSnapshot() {
    return this.snapshot;
  }
}

/** The slice of `ctx.storage.sql` we use (Cloudflare SqlStorage), so it can be faked in tests. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

type Row = Record<string, unknown>;

/** Event log in Durable Object SQLite: seq PK, id UNIQUE (dedupe), plus the latest snapshot. */
export class SqlEventStore implements EventStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly roomId: string,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      caused_by INTEGER
    )`);
    sql.exec('CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, state TEXT NOT NULL)');
  }

  getById(id: string) {
    const row = this.sql.exec('SELECT * FROM events WHERE id = ?', id).toArray()[0];
    return row ? this.toEvent(row) : undefined;
  }

  after(seq: number, limit = 10_000) {
    return this.sql
      .exec('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', seq, limit)
      .toArray()
      .map((r) => this.toEvent(r));
  }

  lastSeq() {
    const row = this.sql.exec('SELECT MAX(seq) AS m FROM events').toArray()[0];
    return Number(row?.m ?? 0);
  }

  append(e: Event) {
    this.sql.exec(
      'INSERT INTO events (seq, id, ts, type, actor, source, payload, caused_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      e.seq,
      e.id,
      e.ts,
      e.payload.type,
      JSON.stringify(e.actor),
      e.source,
      JSON.stringify(e.payload),
      e.causedBy ?? null,
    );
  }

  saveSnapshot(seq: number, state: RoomState) {
    this.sql.exec('DELETE FROM snapshots');
    this.sql.exec('INSERT INTO snapshots (seq, state) VALUES (?, ?)', seq, JSON.stringify(state));
  }

  loadSnapshot() {
    const row = this.sql
      .exec('SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1')
      .toArray()[0];
    if (!row) return undefined;
    const parsed = RoomStateSchema.safeParse(JSON.parse(String(row.state)));
    // A snapshot we cannot parse is discarded; the caller replays the whole log instead.
    return parsed.success ? { seq: Number(row.seq), state: parsed.data } : undefined;
  }

  /** Rows are re-validated on read, so a corrupt row fails loudly instead of replaying garbage. */
  private toEvent(r: Row): Event {
    return EventSchema.parse({
      id: r.id,
      seq: r.seq,
      roomId: this.roomId,
      ts: r.ts,
      actor: JSON.parse(String(r.actor)),
      source: r.source,
      payload: JSON.parse(String(r.payload)),
      ...(r.caused_by === null || r.caused_by === undefined ? {} : { causedBy: r.caused_by }),
    });
  }
}
