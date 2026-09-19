import type { SymbolKey } from '@clankergram/protocol';
import type {
  ImpactAssessment,
  ImpactReference,
  ReadSet,
  RemoteFacts,
  RepoIndex,
} from './types.js';

export function assessImpact(
  remoteFacts: RemoteFacts,
  localIndex: RepoIndex,
  localReadSet: ReadSet,
): ImpactAssessment {
  const changes = remoteFacts.changes ?? [];
  const candidates = new Set<SymbolKey>([
    ...(remoteFacts.symbols ?? []),
    ...changes.map((change) => change.symbol),
  ]);
  for (const file of remoteFacts.files ?? []) {
    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    for (const symbol of Object.values(localIndex.symbols))
      if (symbol.path === normalized) candidates.add(symbol.key);
  }
  const read = new Set(Object.keys(localReadSet.symbols));
  const references: ImpactReference[] = Object.entries(localIndex.references)
    .flatMap(([path, refs]) =>
      refs.map((reference) => ({ symbol: reference.key, path, line: reference.line })),
    )
    .filter((reference) => candidates.has(reference.symbol))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  const referenced = new Set(references.map((reference) => reference.symbol));
  const impacted = [...candidates]
    .filter((symbol) => read.has(symbol) || referenced.has(symbol))
    .sort();
  const breaking = new Set(
    changes.filter((change) => change.breaking).map((change) => change.symbol),
  );
  const semantic = impacted.some((symbol) => breaking.has(symbol));
  const tier = impacted.length === 0 ? null : semantic ? 'SEMANTIC' : 'PREDICTED';
  const files = [...new Set(references.map((reference) => reference.path))].sort();
  const evidence = references.map((reference) => `${reference.path}:${reference.line}`).join(', ');
  return {
    collides: tier !== null,
    tier,
    symbols: impacted,
    confidence: tier === 'SEMANTIC' ? 1 : tier === 'PREDICTED' ? 0.85 : 0,
    references,
    files,
    detail:
      tier === null
        ? 'No local read-set or reference impact.'
        : `${tier === 'SEMANTIC' ? 'Breaking API change' : 'Planned change'} affects ${impacted.join(', ')}${evidence ? ` at ${evidence}` : ''}.`,
  };
}
