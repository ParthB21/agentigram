import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventStore } from '@agentigram/coordinator';
import { type Event, EventSchema, type RoomState, RoomStateSchema } from '@agentigram/protocol';

/** Durable authority state. Hypercore is the replicated history, while this store hydrates synchronously. */
export class FileEventStore implements EventStore {
  private readonly eventsPath: string;
  private readonly snapshotPath: string;
  private readonly events: Event[];
  private readonly byId: Map<string, Event>;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.eventsPath = join(directory, 'events.jsonl');
    this.snapshotPath = join(directory, 'snapshot.json');
    this.events = existsSync(this.eventsPath)
      ? readFileSync(this.eventsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => EventSchema.parse(JSON.parse(line)))
      : [];
    this.byId = new Map(this.events.map((event) => [event.id, event]));
  }

  getById(id: string): Event | undefined {
    return this.byId.get(id);
  }

  after(seq: number, limit = Number.POSITIVE_INFINITY): Event[] {
    return this.events.filter((event) => event.seq > seq).slice(0, limit);
  }

  lastSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  append(event: Event): void {
    this.events.push(event);
    this.byId.set(event.id, event);
    writeAtomic(
      this.eventsPath,
      `${this.events.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
  }

  saveSnapshot(seq: number, state: RoomState): void {
    writeAtomic(this.snapshotPath, JSON.stringify({ seq, state }));
  }

  loadSnapshot(): { seq: number; state: RoomState } | undefined {
    if (!existsSync(this.snapshotPath)) return undefined;
    const raw = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as {
      seq?: unknown;
      state?: unknown;
    };
    const state = RoomStateSchema.safeParse(raw.state);
    return state.success && typeof raw.seq === 'number'
      ? { seq: raw.seq, state: state.data }
      : undefined;
  }
}

function writeAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}
