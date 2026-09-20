import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerStore } from './store.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('RunnerStore', () => {
  it('persists only sessions belonging to the selected host', () => {
    const base = mkdtempSync(join(tmpdir(), 'agentigram-runner-'));
    directories.push(base);
    const codex = new RunnerStore(base, 'room-frontend', 'codex');
    codex.write('thread-1');
    expect(codex.read()).toBe('thread-1');
    expect(new RunnerStore(base, 'room-frontend', 'claude-code').read()).toBeUndefined();
    codex.clear();
    expect(codex.read()).toBeUndefined();
  });

  it('rejects a live lock and takes over a stale lock', () => {
    const base = mkdtempSync(join(tmpdir(), 'agentigram-runner-'));
    directories.push(base);
    const store = new RunnerStore(base, 'room-frontend', 'codex');
    const release = store.lock(111, () => true);
    expect(() => store.lock(222, () => true)).toThrow(/another runner/);
    const releaseStale = store.lock(333, () => false);
    release();
    releaseStale();
  });
});
