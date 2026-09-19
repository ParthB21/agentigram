import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Event } from '@clankergram/protocol';

/**
 * Events older than this are not injected into agent context on replay.
 * From OpenAgents `adapters/base.js` (STALE_MESSAGE_MAX_AGE_MS): a daemon that was off for a day
 * must not act on hours-old peer instructions unannounced. They still advance the cursor.
 */
export const STALE_EVENT_MAX_AGE_MS = 60 * 60 * 1000;

export type Cursor = { get(): number; set(seq: number): void };

/**
 * Persists the last applied `seq` per room after every batch, so a restart resumes with HELLO
 * `lastSeq` instead of dropping (or re-processing) everything that happened while it was down.
 */
export class CursorStore implements Cursor {
  private seq = 0;

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { lastSeq?: unknown };
      if (typeof raw.lastSeq === 'number' && Number.isInteger(raw.lastSeq) && raw.lastSeq >= 0) {
        this.seq = raw.lastSeq;
      }
    } catch {
      // Missing or corrupt: start from 0 and let the coordinator replay. Never fatal.
    }
  }

  static forRoom(roomId: string, dir = join(homedir(), '.clankergram', 'cursors')): CursorStore {
    return new CursorStore(join(dir, `${roomId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`));
  }

  get(): number {
    return this.seq;
  }

  /** Forget the saved position (replay from 0). The only way to move the cursor backwards. */
  reset(): void {
    this.seq = 0;
    this.write();
  }

  /** Monotonic: a lower value is ignored. Written atomically (temp file + rename). */
  set(seq: number): void {
    if (seq <= this.seq) return;
    this.seq = seq;
    this.write();
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastSeq: this.seq }));
    renameSync(tmp, this.file);
  }
}

/** Splits a replayed batch into events safe to act on and events too old to act on. */
export function partitionStale(
  events: Event[],
  now: number,
  maxAgeMs = STALE_EVENT_MAX_AGE_MS,
): { fresh: Event[]; stale: Event[] } {
  const fresh: Event[] = [];
  const stale: Event[] = [];
  for (const e of events) (now - Date.parse(e.ts) > maxAgeMs ? stale : fresh).push(e);
  return { fresh, stale };
}
