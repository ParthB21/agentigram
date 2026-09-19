import type { RepoIndex } from './types.js';

/** Modules reachable from `paths` through imports (including `paths` themselves), sorted. */
export function importClosure(index: RepoIndex, paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = paths.filter((p) => p in index.imports);
  while (stack.length > 0) {
    const p = stack.pop() as string;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const next of index.imports[p] ?? []) stack.push(next);
  }
  return [...seen].sort();
}

/** Modules that transitively import any of `paths` (including `paths`); used for test selection. */
export function dependentsOf(index: RepoIndex, paths: readonly string[]): string[] {
  const reverse = new Map<string, string[]>();
  for (const [from, tos] of Object.entries(index.imports)) {
    for (const to of tos) reverse.set(to, [...(reverse.get(to) ?? []), from]);
  }
  const seen = new Set<string>();
  const stack = paths.filter((p) => p in index.imports);
  while (stack.length > 0) {
    const p = stack.pop() as string;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const next of reverse.get(p) ?? []) stack.push(next);
  }
  return [...seen].sort();
}
