import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ApiChange, SymbolKey } from '@clankergram/protocol';
import ts from 'typescript';
import { Indexer } from './indexer.js';
import type { IndexedSymbol, RepoIndex } from './types.js';

const execFile = promisify(execFileCallback);
const byString = (a: string, b: string) => a.localeCompare(b);

/** Compare a git revision (or another checkout directory) with a TypeScript worktree. */
export async function apiDelta(base: string, worktree: string): Promise<ApiChange[]> {
  const afterRoot = resolve(worktree);
  const after = new Indexer(afterRoot).index();
  const before = existsSync(resolve(base, 'tsconfig.json'))
    ? new Indexer(resolve(base)).index()
    : await indexGitRevision(afterRoot, base, after);
  return compareIndexes(before, after);
}

async function indexGitRevision(
  root: string,
  revision: string,
  current: RepoIndex,
): Promise<RepoIndex> {
  const prefixResult = await execFile('git', ['rev-parse', '--show-prefix'], { cwd: root });
  const prefix = prefixResult.stdout.trim().replaceAll('\\', '/');
  const { stdout } = await execFile('git', ['ls-tree', '-r', '--name-only', revision], {
    cwd: root,
  });
  const trackedTypeScript = stdout
    .split(/\r?\n/)
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
    .sort(byString);
  const currentModules = new Set(current.modules);
  const sourceRoots = new Set(
    current.modules.flatMap((path) =>
      path.includes('/') ? [path.slice(0, path.indexOf('/'))] : [],
    ),
  );
  const baseFiles = trackedTypeScript.filter(
    (path) =>
      currentModules.has(path) ||
      (path.includes('/') && sourceRoots.has(path.slice(0, path.indexOf('/')))),
  );
  const overlay: Record<string, string> = {};
  for (const path of baseFiles) {
    const blob = await execFile('git', ['show', `${revision}:${prefix}${path}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    overlay[path] = blob.stdout;
  }
  const indexer = new Indexer(root, overlay);
  for (const path of current.modules) if (!baseFiles.includes(path)) indexer.update(path, null);
  return indexer.index();
}

export function compareIndexes(before: RepoIndex, after: RepoIndex): ApiChange[] {
  const keys = [...new Set([...Object.keys(before.symbols), ...Object.keys(after.symbols)])].sort(
    byString,
  );
  return keys.flatMap((key) => {
    const oldSymbol = before.symbols[key];
    const newSymbol = after.symbols[key];
    if (oldSymbol?.signatureHash === newSymbol?.signatureHash) return [];
    return [classifyChange(key, oldSymbol, newSymbol)];
  });
}

export function classifyChange(
  symbol: SymbolKey,
  before: IndexedSymbol | undefined,
  after: IndexedSymbol | undefined,
): ApiChange {
  if (!before) {
    const optional = after?.member !== undefined && /\?:/.test(after.signature);
    return {
      symbol,
      before: null,
      after: after?.signature ?? null,
      breaking: Boolean(after?.member) && !optional,
      reason: optional
        ? 'Optional member added.'
        : after?.member
          ? 'Required member added.'
          : 'Export added.',
    };
  }
  if (!after) {
    return {
      symbol,
      before: before.signature,
      after: null,
      breaking: true,
      reason: before.member ? 'Member removed.' : 'Export removed.',
    };
  }

  const enumOrLiteral =
    before.kind === 'enum' || literalUnion(before.signature) || literalUnion(after.signature);
  if (enumOrLiteral) {
    return changed(symbol, before, after, true, 'Enum or literal-union members changed.');
  }
  const oldFn = functionShape(before.signature);
  const newFn = functionShape(after.signature);
  if (oldFn && newFn) {
    if (oldFn.required !== newFn.required) {
      return changed(symbol, before, after, true, 'Required parameter arity changed.');
    }
    const acceptsOldArguments = assignable(oldFn.parametersTuple, newFn.parametersTuple);
    const preservesOutputs = assignable(newFn.returnType, oldFn.returnType);
    const breaking = !acceptsOldArguments || !preservesOutputs;
    return changed(
      symbol,
      before,
      after,
      breaking,
      breaking
        ? 'Function inputs or outputs changed incompatibly.'
        : 'Function signature widened compatibly.',
    );
  }
  const oldType = surfaceType(before.signature);
  const newType = surfaceType(after.signature);
  const breaking = !assignable(newType, oldType);
  return changed(
    symbol,
    before,
    after,
    breaking,
    breaking ? 'Output type changed incompatibly.' : 'Type changed compatibly.',
  );
}

function changed(
  symbol: SymbolKey,
  before: IndexedSymbol,
  after: IndexedSymbol,
  breaking: boolean,
  reason: string,
): ApiChange {
  return { symbol, before: before.signature, after: after.signature, breaking, reason };
}

function literalUnion(signature: string): boolean {
  return /(?:^|\s)(?:'[^']*'|"[^"]*"|\d+)(?:\s*\|\s*(?:'[^']*'|"[^"]*"|\d+))+/.test(signature);
}

function surfaceType(signature: string): string {
  const property = signature.match(/^(?:readonly\s+)?[^:]+\??:\s*(.+)$/s);
  if (property?.[1]) return property[1];
  const alias = signature.match(/^type\s+[^=]+?=\s*(.+)$/s);
  return alias?.[1] ?? signature;
}

function functionShape(
  signature: string,
): { required: number; parametersTuple: string; returnType: string } | undefined {
  const source = ts.createSourceFile(
    'shape.ts',
    `type F = ${signature};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = source.statements[0];
  if (!statement || !ts.isTypeAliasDeclaration(statement)) return undefined;
  const node = statement.type;
  const call = ts.isFunctionTypeNode(node) ? node : undefined;
  if (!call) return undefined;
  const required = call.parameters.filter(
    (parameter) => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken,
  ).length;
  const parametersTuple = `[${call.parameters
    .map(
      (parameter) =>
        `${parameter.dotDotDotToken ? '...' : ''}${parameter.type?.getText() ?? 'any'}${parameter.questionToken ? '?' : ''}`,
    )
    .join(', ')}]`;
  return { required, parametersTuple, returnType: call.type.getText() };
}

function assignable(from: string, to: string): boolean {
  const fileName = 'compat.ts';
  const source = `type From = ${from};\ntype To = ${to};\ndeclare const value: From;\nconst target: To = value;`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => (name === fileName ? source : ts.sys.readFile(name));
  const program = ts.createProgram([fileName], options, host);
  return program.getSemanticDiagnostics().length === 0;
}

/** Utility used by the speculative merge worker for diagnostics and tests. */
export function repoRelative(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).replaceAll('\\', '/');
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
