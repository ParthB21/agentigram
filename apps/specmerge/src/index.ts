import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { dependentsOf, indexRepo } from '@agentigram/analysis';
import { type CheckFile, compile } from '@agentigram/contracts';
import type { Contract, Payload } from '@agentigram/protocol';

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 20_000;

export type SessionDiff = { sessionId: string; leaseSeq: number; patch: string };
export type EncryptedSessionDiff = {
  sessionId: string;
  leaseSeq: number;
  encryptedPatch: string;
};
export type SpecMergeRequest = {
  roomId?: string;
  root?: string;
  baseCommit: string;
  sessions: string[] | Array<{ sessionId: string; leaseSeq: number }>;
  diffs: Record<string, string> | Array<SessionDiff | EncryptedSessionDiff>;
  contracts?: Contract[];
  timeoutMs?: number;
  projectPath?: string;
};
export type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
export type SpecMergeOptions = {
  runner?: (
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<CommandResult>;
  patcher?: (patch: string, cwd: string, timeoutMs: number) => Promise<CommandResult>;
  decryptPatch?: (encryptedPatch: string, sessionId: string) => Promise<string>;
};

/** Apply session patches in lease order in a disposable authority-local worktree. */
export async function runSpeculativeMerge(
  request: SpecMergeRequest,
  options: SpecMergeOptions = {},
): Promise<Extract<Payload, { type: 'SPEC_MERGE_RESULT' }>> {
  const repository = resolve(request.root ?? process.cwd());
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessions = await orderedDiffs(request, options.decryptPatch);
  const sessionIds = sessions.map((entry) => entry.sessionId);
  const temp = mkdtempSync(join(repository, '.agentigram-specmerge-'));
  const runner = options.runner ?? runCommand;
  const changedPaths = new Set<string>();
  let worktreeAdded = false;
  try {
    const add = await runner(
      'git',
      ['worktree', 'add', '--detach', temp, request.baseCommit],
      repository,
      timeoutMs,
    );
    if (add.exitCode !== 0)
      return failure(request.baseCommit, sessionIds, add.stderr || add.stdout, 'WORKTREE');
    worktreeAdded = true;
    for (const diff of sessions) {
      for (const path of pathsFromPatch(diff.patch)) changedPaths.add(path);
      const applied = await (options.patcher ?? applyPatch)(diff.patch, temp, timeoutMs);
      diff.patch = '';
      if (applied.timedOut)
        return {
          type: 'SPEC_MERGE_RESULT',
          baseCommit: request.baseCommit,
          sessions: sessionIds,
          typeErrors: [],
          failingTests: [],
          notRun: ['patch apply', 'typecheck', 'tests', 'contracts'],
        };
      if (applied.exitCode !== 0)
        return failure(
          request.baseCommit,
          sessionIds,
          applied.stderr || applied.stdout,
          'TEXTUAL_CONFLICT',
        );
    }
    const checkFiles = (request.contracts ?? []).flatMap(
      (contract) => compile(contract).checkFiles,
    );
    const executionRoot = safeProjectRoot(temp, request.projectPath);
    writeChecks(executionRoot, checkFiles);
    const typecheckArgs =
      checkFiles.length > 0
        ? ['pnpm', 'exec', 'tsc', '--noEmit', '-p', '.agentigram/tsconfig.contracts.json']
        : ['pnpm', 'exec', 'tsc', '--noEmit'];
    const typecheck = await runner('corepack', typecheckArgs, executionRoot, timeoutMs);
    const typecheckOutput = `${typecheck.stdout}\n${typecheck.stderr}`;
    const typeErrors = parseTypeErrors(typecheckOutput);
    if (typecheck.timedOut)
      return {
        type: 'SPEC_MERGE_RESULT',
        baseCommit: request.baseCommit,
        sessions: sessionIds,
        typeErrors,
        failingTests: [],
        notRun: ['typecheck (timed out)', 'tests', ...(checkFiles.length ? ['contracts'] : [])],
      };
    const affectedTests = await selectAffectedTests(
      executionRoot,
      [...changedPaths],
      request.projectPath,
    );
    const tests = await runner(
      'corepack',
      ['pnpm', 'exec', 'vitest', 'run', ...affectedTests],
      executionRoot,
      timeoutMs,
    );
    const failingTests = parseFailingTests(`${tests.stdout}\n${tests.stderr}`);
    if (checkFiles.length > 0 && typecheck.exitCode !== 0 && typeErrors.length === 0)
      typeErrors.push({
        file: '.agentigram/contracts',
        code: 'CONTRACT_CHECK',
        message: typecheckOutput.trim() || 'Contract type checking failed.',
      });
    return {
      type: 'SPEC_MERGE_RESULT',
      baseCommit: request.baseCommit,
      sessions: sessionIds,
      typeErrors,
      failingTests,
      notRun: tests.timedOut ? ['tests (timed out)'] : [],
    };
  } finally {
    for (const entry of sessions) entry.patch = '';
    if (worktreeAdded) {
      await runner('git', ['worktree', 'remove', '--force', temp], repository, timeoutMs).catch(
        () => undefined,
      );
      await runner('git', ['worktree', 'prune'], repository, timeoutMs).catch(() => undefined);
    }
    const relativeTemp = relative(repository, temp);
    if (relativeTemp.startsWith('.agentigram-specmerge-') && !relativeTemp.includes('..'))
      rmSync(temp, { recursive: true, force: true });
  }
}

function pathsFromPatch(patch: string): string[] {
  return patch.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/);
    return match?.[1] && match[1] !== '/dev/null' ? [match[1].replaceAll('\\', '/')] : [];
  });
}

async function selectAffectedTests(
  projectRoot: string,
  changedPaths: string[],
  projectPath: string | undefined,
): Promise<string[]> {
  if (changedPaths.length === 0) return [];
  const prefix = projectPath?.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const local = changedPaths.map((path) =>
    prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path,
  );
  try {
    const index = await indexRepo(projectRoot);
    return dependentsOf(index, local)
      .filter((path) => /(?:^|\/).*(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path))
      .sort();
  } catch {
    return [];
  }
}

async function orderedDiffs(
  request: SpecMergeRequest,
  decryptPatch?: SpecMergeOptions['decryptPatch'],
): Promise<SessionDiff[]> {
  if (Array.isArray(request.diffs)) {
    const entries = await Promise.all(
      request.diffs.map(async (entry) => ({
        sessionId: entry.sessionId,
        leaseSeq: entry.leaseSeq,
        patch:
          'patch' in entry
            ? entry.patch
            : decryptPatch
              ? await decryptPatch(entry.encryptedPatch, entry.sessionId)
              : missingDecryptor(),
      })),
    );
    return entries.sort(
      (a, b) => a.leaseSeq - b.leaseSeq || a.sessionId.localeCompare(b.sessionId),
    );
  }
  const sequence = new Map(
    request.sessions.map((session, index) => [
      typeof session === 'string' ? session : session.sessionId,
      typeof session === 'string' ? index : session.leaseSeq,
    ]),
  );
  return Object.entries(request.diffs)
    .map(([sessionId, patch]) => ({
      sessionId,
      patch,
      leaseSeq: sequence.get(sessionId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.leaseSeq - b.leaseSeq || a.sessionId.localeCompare(b.sessionId));
}

function missingDecryptor(): never {
  throw new Error('Encrypted diff requires an authority-local decryptPatch adapter');
}

function safeProjectRoot(worktree: string, projectPath: string | undefined): string {
  const target = resolve(worktree, projectPath ?? '.');
  const rel = relative(worktree, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('projectPath escapes worktree');
  return target;
}

function writeChecks(root: string, files: CheckFile[]): void {
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`))
      throw new Error(`Contract path escapes worktree: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  if (files.length > 0) {
    const configPath = resolve(root, '.agentigram/tsconfig.contracts.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ extends: '../tsconfig.json', compilerOptions: { noEmit: true }, include: ['contracts/**/*.ts', '../src/**/*.ts', '../test/**/*.ts', '../tests/**/*.ts'] }, null, 2)}\n`,
      'utf8',
    );
  }
}

function applyPatch(patch: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', ['apply', '--whitespace=nowarn', '-'], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveResult({ exitCode: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.end(patch);
  });
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const result = await execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
      timedOut: Boolean(failure.killed),
    };
  }
}

function parseTypeErrors(
  output: string,
): Array<{ file: string; line?: number; code?: string; message: string }> {
  const errors: Array<{ file: string; line?: number; code?: string; message: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^(.+?)(?:\((\d+),(?:\d+)\)|:(\d+):(?:\d+))\s*[-:]?\s*error\s+(TS\d+):\s+(.+)$/,
    );
    if (match?.[1] && (match[2] || match[3]) && match[4] && match[5])
      errors.push({
        file: match[1].replaceAll('\\', '/'),
        line: Number(match[2] ?? match[3]),
        code: match[4],
        message: match[5],
      });
  }
  return errors;
}

function parseFailingTests(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/(?:FAIL|×|\bfailed\b)\s+([^\s].*?)(?:\s+\(\d+\))?$/i);
    if (match?.[1]) found.add(match[1].trim());
  }
  return [...found].sort();
}

function failure(
  baseCommit: string,
  sessions: string[],
  message: string,
  code: string,
): Extract<Payload, { type: 'SPEC_MERGE_RESULT' }> {
  return {
    type: 'SPEC_MERGE_RESULT',
    baseCommit,
    sessions,
    typeErrors: [{ file: '', code, message: message.trim() || code }],
    failingTests: [],
    notRun: ['typecheck', 'tests', 'contracts'],
  };
}

/** Newline-delimited JSON local worker for the daemon's Unix socket / named pipe. */
export function startSpecMergeWorker(socketPath: string, options: SpecMergeOptions = {}): Server {
  if (!isAbsolute(socketPath) && !socketPath.startsWith('\\\\.\\pipe\\'))
    throw new Error('Worker socket path must be absolute');
  if (existsSync(socketPath) && process.platform !== 'win32') rmSync(socketPath, { force: true });
  return createServer((connection) => {
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handleWorkerLine(raw, connection, options);
        newline = buffer.indexOf('\n');
      }
    });
  }).listen(socketPath);
}

async function handleWorkerLine(
  raw: string,
  connection: NodeJS.WritableStream,
  options: SpecMergeOptions,
): Promise<void> {
  try {
    const result = await runSpeculativeMerge(JSON.parse(raw) as SpecMergeRequest, options);
    connection.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    const errorId = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    connection.write(
      `${JSON.stringify({ ok: false, errorId, message: error instanceof Error ? error.message : String(error) })}\n`,
    );
  }
}
