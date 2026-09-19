import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

export const toPosix = (p: string) => p.replaceAll('\\', '/');

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * A LanguageService over a repo, with an overlay of in-memory file contents so the daemon can
 * feed edits (or a git blob at another commit) without touching disk. Each `update` bumps the
 * file's version, so TypeScript re-parses only that file: this is the incremental path.
 */
export class RepoHost {
  readonly root: string;
  readonly service: ts.LanguageService;
  private readonly options: ts.CompilerOptions;
  private readonly files = new Set<string>();
  private readonly versions = new Map<string, number>();
  /** absolute path -> contents; `null` means deleted. */
  private readonly overlay = new Map<string, string | null>();
  private readonly registry = ts.createDocumentRegistry();

  constructor(root: string, overlay?: Record<string, string>) {
    this.root = toPosix(resolve(root));
    const configPath = ts.findConfigFile(this.root, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new ConfigError(`no tsconfig.json found at or above ${this.root}`);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error)
      throw new ConfigError(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
    this.options = { ...parsed.options, noEmit: true, incremental: false, composite: false };
    for (const f of parsed.fileNames) this.files.add(toPosix(f));
    for (const [rel, text] of Object.entries(overlay ?? {})) this.set(rel, text);
    this.service = ts.createLanguageService(this.host(), this.registry);
  }

  abs(rel: string): string {
    return toPosix(isAbsolute(rel) ? rel : resolve(this.root, rel));
  }

  rel(abs: string): string {
    return toPosix(relative(this.root, abs));
  }

  /** Repo file (not a lib, not node_modules, not generated). */
  isRepoFile(abs: string): boolean {
    const r = this.rel(abs);
    return (
      !r.startsWith('..') &&
      !r.includes('node_modules/') &&
      !r.startsWith('.clankergram/') &&
      !r.startsWith('.agentigram/')
    );
  }

  /** Replace a file's contents (creating it if new), or delete it with `null`. */
  set(rel: string, text: string | null): void {
    const abs = this.abs(rel);
    this.overlay.set(abs, text);
    if (text === null) this.files.delete(abs);
    else this.files.add(abs);
    this.versions.set(abs, (this.versions.get(abs) ?? 0) + 1);
  }

  /** Re-read files from disk (the watcher path): drops overlay entries and bumps versions. */
  refreshFromDisk(rels: string[]): void {
    for (const rel of rels) {
      const abs = this.abs(rel);
      this.overlay.delete(abs);
      if (ts.sys.fileExists(abs)) this.files.add(abs);
      else this.files.delete(abs);
      this.versions.set(abs, (this.versions.get(abs) ?? 0) + 1);
    }
  }

  private read(abs: string): string | undefined {
    if (this.overlay.has(abs)) return this.overlay.get(abs) ?? undefined;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Overlay-aware host for `ts.resolveModuleName`. */
  moduleHost(): ts.ModuleResolutionHost {
    return {
      fileExists: (f) => {
        const abs = toPosix(f);
        return this.overlay.has(abs) ? this.overlay.get(abs) !== null : ts.sys.fileExists(f);
      },
      readFile: (f) => this.read(toPosix(f)) ?? ts.sys.readFile(f),
      directoryExists: ts.sys.directoryExists,
      getCurrentDirectory: () => this.root,
    };
  }

  private host(): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [...this.files].sort(),
      getScriptVersion: (f) => String(this.versions.get(toPosix(f)) ?? 0),
      getScriptSnapshot: (f) => {
        const text = this.read(toPosix(f)) ?? ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => {
        const abs = toPosix(f);
        return this.overlay.has(abs) ? this.overlay.get(abs) !== null : ts.sys.fileExists(f);
      },
      readFile: (f) => this.read(toPosix(f)) ?? ts.sys.readFile(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
  }
}
