import {
  type ApiChange,
  type CollisionTier,
  NotImplementedError,
  type SymbolKey,
} from '@clankergram/protocol';

/** Symbol facts only: keys, signature hashes and short signature text. Never source. */
export type RepoIndex = {
  root: string;
  symbols: Record<SymbolKey, { signatureHash: string; signature: string }>;
  /** module path -> module paths it imports */
  imports: Record<string, string[]>;
};

/** Symbols a session has read, with the ms timestamp of the last read (decayed over time). */
export type ReadSet = { symbols: Record<SymbolKey, number> };

export type ResolvedIntent = {
  symbols: SymbolKey[];
  confidence: number;
  method: 'language-service' | 'llm';
};

/** Facts another daemon published: what it changed. */
export type RemoteFacts = { writerSession: string; changes: ApiChange[] };

export type ImpactAssessment = {
  collides: boolean;
  tier: CollisionTier | null;
  symbols: SymbolKey[];
  confidence: number;
};

export function indexRepo(_root: string): Promise<RepoIndex> {
  throw new NotImplementedError('analysis.indexRepo (Part 3)');
}

export function apiDelta(_base: string, _worktree: string): Promise<ApiChange[]> {
  throw new NotImplementedError('analysis.apiDelta (Part 3)');
}

export function resolveIntent(
  _text: string,
  _files: string[],
  _symbols?: SymbolKey[],
): Promise<ResolvedIntent> {
  throw new NotImplementedError('analysis.resolveIntent (Part 3)');
}

export function readSetFromFiles(_paths: string[]): Promise<ReadSet> {
  throw new NotImplementedError('analysis.readSetFromFiles (Part 3)');
}

export function assessImpact(
  _remoteFacts: RemoteFacts,
  _localIndex: RepoIndex,
  _localReadSet: ReadSet,
): ImpactAssessment {
  throw new NotImplementedError('analysis.assessImpact (Part 3)');
}
