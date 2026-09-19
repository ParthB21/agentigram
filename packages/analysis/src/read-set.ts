import { isAbsolute, relative } from 'node:path';
import { toPosix } from './host.js';
import type { ReadSet, RepoIndex } from './types.js';

/**
 * Symbol keys defined in, or referenced by, `paths`: what reading those files tells us an agent
 * now depends on. `atMs` stamps the read; the daemon decays and merges read sets over time.
 */
export function readSetFromFiles(
  paths: readonly string[],
  index: RepoIndex,
  atMs: number = Date.now(),
): ReadSet {
  const wanted = new Set(
    paths.map((p) => toPosix(isAbsolute(p) ? relative(index.root, p) : p).replace(/^\.\//, '')),
  );
  const symbols: ReadSet['symbols'] = {};
  for (const s of Object.values(index.symbols)) if (wanted.has(s.path)) symbols[s.key] = atMs;
  for (const p of wanted) for (const r of index.references[p] ?? []) symbols[r.key] = atMs;
  return { symbols };
}
