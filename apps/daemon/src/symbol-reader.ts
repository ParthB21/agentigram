import { resolve } from 'node:path';
import { Indexer, readSetFromFiles } from '@agentigram/analysis';
import type { SymbolKey } from '@agentigram/protocol';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

/**
 * Turns "the agent read these files" into symbol keys, using `@agentigram/analysis`'s index.
 * One long-lived `Indexer` per repo: only files reported via `markDirty` are re-parsed, and the
 * first index is built off the hook path (`warm`) so a cold TypeScript program never eats a
 * hook's time budget. Failure (no tsconfig, non-TS repo) degrades to "no symbols", never an error.
 */
export class SymbolReader {
  private indexer: Indexer | undefined;
  private unavailable = false;
  private readonly dirty = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly log: Log,
  ) {}

  /** A file changed on disk (agent write or watcher). Repo-relative, POSIX separators. */
  markDirty(paths: readonly string[]): void {
    for (const p of paths) this.dirty.add(p);
  }

  /** Build the index in the background so the first hook does not pay for it. */
  warm(): void {
    setImmediate(() => {
      try {
        this.current()?.index();
      } catch (error) {
        this.log.warn({ err: String(error) }, 'symbol index warm-up failed');
      }
    });
  }

  read(paths: readonly string[], cwd?: string): SymbolKey[] {
    const indexer = this.current();
    if (!indexer) return [];
    try {
      if (this.dirty.size > 0) {
        indexer.refreshFromDisk([...this.dirty]);
        this.dirty.clear();
      }
      const absolute = paths.map((p) => resolve(cwd ?? this.root, p));
      return Object.keys(readSetFromFiles(absolute, indexer.index(), Date.now()).symbols);
    } catch (error) {
      this.log.warn({ err: String(error) }, 'reading symbols failed; FILE_READ carries none');
      return [];
    }
  }

  private current(): Indexer | undefined {
    if (this.unavailable) return undefined;
    try {
      this.indexer ??= new Indexer(this.root);
      return this.indexer;
    } catch (error) {
      this.unavailable = true;
      this.log.info(
        { err: String(error) },
        'no symbol index for this repo; FILE_READ carries no symbols',
      );
      return undefined;
    }
  }
}
