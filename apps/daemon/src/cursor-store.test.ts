import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { CursorStore, partitionStale, STALE_EVENT_MAX_AGE_MS } from './cursor-store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'clankergram-cursor-'));

describe('CursorStore', () => {
  it('persists across instances and only moves forward', () => {
    const d = dir();
    const a = CursorStore.forRoom('hackathon', d);
    expect(a.get()).toBe(0);
    a.set(5);
    a.set(3);
    expect(CursorStore.forRoom('hackathon', d).get()).toBe(5);
  });

  it('starts from 0 on a corrupt file instead of crashing', () => {
    const d = dir();
    const file = join(d, 'r.json');
    writeFileSync(file, '{not json');
    expect(new CursorStore(file).get()).toBe(0);
    writeFileSync(file, JSON.stringify({ lastSeq: -4 }));
    expect(new CursorStore(file).get()).toBe(0);
  });

  it('sanitises the room id used in the file name and can reset', () => {
    const d = dir();
    const c = CursorStore.forRoom('../evil/room', d);
    c.set(2);
    expect(readFileSync(join(d, '___evil_room.json'), 'utf8')).toContain('2');
    c.reset();
    expect(CursorStore.forRoom('../evil/room', d).get()).toBe(0);
  });
});

describe('partitionStale', () => {
  it('separates events too old to act on', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const at = (ms: number) => ({ ts: new Date(now - ms).toISOString() }) as Event;
    const { fresh, stale } = partitionStale([at(1000), at(STALE_EVENT_MAX_AGE_MS + 1)], now);
    expect(fresh).toHaveLength(1);
    expect(stale).toHaveLength(1);
  });
});
