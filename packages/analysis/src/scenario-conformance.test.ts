import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Payload } from '@clankergram/protocol';
import { userIdUuid } from '@clankergram/simulator';
import { describe, expect, it } from 'vitest';
import { Indexer } from './index.js';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../demo-repo');

/** Every symbol key and file the canonical scenario names, from its event payloads. */
function named(payloads: Payload[]) {
  const keys = new Set<string>();
  const files = new Set<string>();
  for (const p of payloads) {
    if (p.type === 'FILE_READ') {
      files.add(p.path);
      for (const k of p.symbols ?? []) keys.add(k);
    } else if (p.type === 'FILE_WRITE') files.add(p.path);
    else if (p.type === 'INTENT') {
      for (const f of p.files) files.add(f);
      for (const k of p.symbols) keys.add(k);
    } else if (p.type === 'API_DELTA') {
      files.add(p.module);
      for (const c of p.changes) keys.add(c.symbol);
    } else if (
      p.type === 'COLLISION' ||
      p.type === 'LEASE_REQUESTED' ||
      p.type === 'LEASE_GRANTED' ||
      p.type === 'LEASE_DENIED'
    ) {
      for (const k of p.symbols) keys.add(k);
    }
  }
  return { keys: [...keys].sort(), files: [...files].sort() };
}

describe('user-id-uuid scenario against the real demo repo', () => {
  const idx = new Indexer(DEMO).index();
  const { keys, files } = named(userIdUuid.steps.map((s) => s.event.payload));

  it('every symbol key the scenario names exists in the demo repo index, with the scripted signature', () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(idx.symbols[k], k).toBeDefined();
    const delta = userIdUuid.steps.map((s) => s.event.payload).find((p) => p.type === 'API_DELTA');
    const change = delta?.type === 'API_DELTA' ? delta.changes[0] : undefined;
    expect(idx.symbols[change?.symbol ?? '']?.signature).toBe(`id: ${change?.before}`);
  });

  it('files the scenario names exist, except one known drift (reported to the scenario owner)', () => {
    const missing = files.filter((f) => !existsSync(resolve(DEMO, f)));
    // Frontend reads src/ui/profile.tsx in the scenario; the demo repo has no src/ui/.
    expect(missing).toEqual(['src/ui/profile.tsx']);
  });
});
