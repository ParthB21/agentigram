import type { ApiChange, CollisionTier, SymbolKey, SymbolKind } from '@clankergram/protocol';

/**
 * One exported symbol or member. Only keys, signatures and hashes ever leave the laptop
 * (CLAUDE.md rule 7); `path` and `line` are local navigation aids.
 */
export type IndexedSymbol = {
  key: SymbolKey;
  kind: SymbolKind;
  /** Repo-relative module path, `/` separated. */
  path: string;
  exportName: string;
  member?: string;
  /** Normalised signature text, stable across machines and formatting. */
  signature: string;
  /** First 16 hex chars of sha256(signature). */
  signatureHash: string;
  /** 1-based line of the declaration name. */
  line: number;
};

/** A place in the repo that uses an indexed symbol declared in another module. */
export type Reference = { key: SymbolKey; path: string; line: number };

export type RepoIndex = {
  root: string;
  /** Every indexed module (repo-relative), sorted. Includes tests. */
  modules: string[];
  symbols: Record<SymbolKey, IndexedSymbol>;
  /** module -> repo modules it imports (resolved, sorted). */
  imports: Record<string, string[]>;
  /** module -> external symbol references, sorted by (line, key). */
  references: Record<string, Reference[]>;
};

/** Symbols a session has read, with the ms timestamp of the last read (decayed by the daemon). */
export type ReadSet = { symbols: Record<SymbolKey, number> };

export type ResolvedIntent = {
  symbols: SymbolKey[];
  /** Per symbol, 0..1. */
  confidence: Record<SymbolKey, number>;
  method: 'explicit' | 'files' | 'identifiers' | 'llm';
  llmUsed: boolean;
};

/** Facts another daemon published: what it intends or changed. */
export type RemoteFacts = {
  writerSession: string;
  /** API changes are semantic facts. Intent-only callers may provide `symbols`/`files`. */
  changes?: ApiChange[];
  symbols?: SymbolKey[];
  files?: string[];
};

export type ImpactReference = { symbol: SymbolKey; path: string; line: number };

export type ImpactAssessment = {
  collides: boolean;
  tier: CollisionTier | null;
  symbols: SymbolKey[];
  confidence: number;
  /** Exact local evidence suitable for the collision detail shown to humans and agents. */
  references: ImpactReference[];
  files: string[];
  detail: string;
};
