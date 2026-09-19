import type { SymbolKey } from '@clankergram/protocol';
import type { RepoIndex, ResolvedIntent } from './types.js';

const keyPath = (key: string) => key.slice(0, key.indexOf('#'));
const identifiers = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);

/** Deterministic intent resolution. An index is optional for backwards compatibility. */
export async function resolveIntent(
  text: string,
  files: string[],
  symbols: SymbolKey[] = [],
  index?: RepoIndex,
): Promise<ResolvedIntent> {
  const known = index ? new Set(Object.keys(index.symbols)) : undefined;
  const explicit = [...new Set(symbols)].filter((key) => !known || known.has(key)).sort();
  if (explicit.length > 0) return result(explicit, 1, 'explicit');
  if (!index) return { symbols: [], confidence: {}, method: 'identifiers', llmUsed: false };

  const normalFiles = new Set(files.map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '')));
  const fromFiles = Object.keys(index.symbols)
    .filter((key) => normalFiles.has(keyPath(key)))
    .sort();
  if (fromFiles.length > 0) return result(fromFiles, 0.9, 'files');

  const words = identifiers(text.toLowerCase());
  const lowered = text.toLowerCase();
  const qualified = Object.values(index.symbols)
    .filter(
      (symbol) =>
        symbol.member && lowered.includes(`${symbol.exportName}.${symbol.member}`.toLowerCase()),
    )
    .map((symbol) => symbol.key)
    .sort();
  if (qualified.length > 0) return result(qualified, 0.82, 'identifiers');
  const matches = Object.values(index.symbols)
    .filter((symbol) => {
      const names = [symbol.exportName, symbol.member].flatMap((name) =>
        name ? [name.toLowerCase()] : [],
      );
      return names.some((name) => words.has(name));
    })
    .map((symbol) => symbol.key)
    .sort();
  return result(matches, matches.length > 0 ? 0.7 : 0, 'identifiers');
}

function result(
  symbols: SymbolKey[],
  confidence: number,
  method: ResolvedIntent['method'],
): ResolvedIntent {
  return {
    symbols,
    confidence: Object.fromEntries(symbols.map((symbol) => [symbol, confidence])),
    method,
    llmUsed: false,
  };
}
