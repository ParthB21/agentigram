import { type ApiChange, NotImplementedError, type SymbolKey } from '@clankergram/protocol';
import type { ImpactAssessment, ReadSet, RemoteFacts, RepoIndex, ResolvedIntent } from './types.js';

export * from './graph.js';
export { ConfigError } from './host.js';
export { Indexer, indexRepo } from './indexer.js';
export * from './overlap.js';
export * from './read-set.js';
export * from './types.js';

// M2 (Part 3): API delta, intent resolution and impact assessment. Signatures are agreed with Part 2.

export function apiDelta(_base: string, _worktree: string): Promise<ApiChange[]> {
  throw new NotImplementedError('analysis.apiDelta (Part 3, M2)');
}

export function resolveIntent(
  _text: string,
  _files: string[],
  _symbols?: SymbolKey[],
): Promise<ResolvedIntent> {
  throw new NotImplementedError('analysis.resolveIntent (Part 3, M2)');
}

export function assessImpact(
  _remoteFacts: RemoteFacts,
  _localIndex: RepoIndex,
  _localReadSet: ReadSet,
): ImpactAssessment {
  throw new NotImplementedError('analysis.assessImpact (Part 3, M2)');
}
