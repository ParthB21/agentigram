import type { SymbolKey } from '@clankergram/protocol';
import { type Ctx, extractModule } from './extract.js';
import { RepoHost } from './host.js';
import { collectImports, collectReferences } from './references.js';
import type { IndexedSymbol, Reference, RepoIndex } from './types.js';

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds a `RepoIndex` from a TypeScript LanguageService. Long-lived: call `update` /
 * `refreshFromDisk` as files change, then `index()` again. TypeScript re-parses only the touched
 * files; extraction re-runs across the (small) program, which is well inside the budget.
 */
export class Indexer {
  readonly host: RepoHost;

  constructor(root: string, overlay?: Record<string, string>) {
    this.host = new RepoHost(root, overlay);
  }

  /** Replace (or with `null`, delete) a file's contents without touching disk. */
  update(rel: string, text: string | null): void {
    this.host.set(rel, text);
  }

  refreshFromDisk(rels: string[]): void {
    this.host.refreshFromDisk(rels);
  }

  index(): RepoIndex {
    const program = this.host.service.getProgram();
    if (!program) throw new Error('language service produced no program');
    const checker = program.getTypeChecker();
    const ctx: Ctx = {
      checker,
      rel: (abs) => this.host.rel(abs),
      isRepoFile: (abs) => this.host.isRepoFile(abs),
      declKeys: new Map(),
    };
    const files = program
      .getSourceFiles()
      .filter(
        (sf) =>
          !sf.isDeclarationFile &&
          !program.isSourceFileFromExternalLibrary(sf) &&
          !program.isSourceFileDefaultLibrary(sf) &&
          this.host.isRepoFile(sf.fileName),
      )
      .sort((a, b) => byString(ctx.rel(a.fileName), ctx.rel(b.fileName)));

    // Pass 1 registers every declaration's key; pass 2 resolves references against them.
    const all: IndexedSymbol[] = [];
    for (const sf of files) all.push(...extractModule(ctx, sf));
    const symbols: Record<SymbolKey, IndexedSymbol> = {};
    for (const s of all.sort((a, b) => byString(a.key, b.key))) symbols[s.key] = s;

    const options = program.getCompilerOptions();
    const resolutionHost = this.host.moduleHost();
    const imports: Record<string, string[]> = {};
    const references: Record<string, Reference[]> = {};
    for (const sf of files) {
      const path = ctx.rel(sf.fileName);
      imports[path] = collectImports(sf, options, resolutionHost, ctx);
      references[path] = collectReferences(ctx, sf);
    }
    return {
      root: this.host.root,
      modules: files.map((sf) => ctx.rel(sf.fileName)),
      symbols,
      imports,
      references,
    };
  }
}

/** Cold index of a repo on disk (reads its tsconfig). For repeated indexing keep an `Indexer`. */
export async function indexRepo(root: string): Promise<RepoIndex> {
  return new Indexer(root).index();
}
