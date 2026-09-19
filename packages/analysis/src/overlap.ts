import { toPosix } from './host.js';

const norm = (p: string) => toPosix(p).replace(/^\.\//, '');

/** Tier 0: paths present in both write sets, sorted. Pure set intersection, no I/O. */
export function fileOverlap(a: readonly string[], b: readonly string[]): string[] {
  const right = new Set(b.map(norm));
  return [...new Set(a.map(norm))].filter((p) => right.has(p)).sort();
}
