import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapability, decodeInvite } from '@agentigram/p2p';
import { Command } from 'commander';
import pino from 'pino';
import { CursorStore } from './cursor-store.js';
import { LaptopDaemon } from './daemon.js';
import { runLocalDemo } from './demo.js';
import {
  type InstallState,
  install,
  readInstallState,
  uninstall,
  writeInstallState,
} from './install.js';
import { DEFAULT_HOOK_TIMEOUT_MS, PRE_TOOL_TIMEOUT_MS, requestIpc } from './ipc.js';
import { runMcpServer } from './mcp-server.js';
import { RoomClient } from './room-client.js';
import { IpcRunnerClient } from './runner/client.js';
import { createAdapter } from './runner/hosts.js';
import { ManagedRunner } from './runner/orchestrator.js';
import { spawnHost } from './runner/spawn-host.js';
import { RunnerStore } from './runner/store.js';
import { runtimeKey, runtimePaths } from './runtime.js';
import { summarise } from './summary.js';

const executable = fileURLToPath(new URL('../bin/agentigram.mjs', import.meta.url));
const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_POLL_MS = 100;

export function resolveRepositoryRoot(root: string, invocationDirectory: string): string {
  return resolve(invocationDirectory, root);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function requiredState(root: string): InstallState {
  const state = readInstallState(root);
  if (!state) throw new Error(`Agentigram is not joined in ${root}`);
  // Installs created before stable authority identities were introduced get a
  // seed exactly once. Keeping it in the protected install state means daemon
  // restarts no longer invalidate every outstanding room invite.
  if (state.mode === 'authority' && !state.authoritySeed) {
    state.authoritySeed = randomBytes(32).toString('hex');
    writeInstallState(state);
  }
  return state;
}

function host(value?: string): InstallState['host'] {
  if (!value) {
    throw new Error(
      'could not detect an agent host; pass --host claude, --host codex, --host gemini, or --host antigravity',
    );
  }
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'codex') return 'codex';
  if (value === 'gemini' || value === 'gemini-cli') return 'gemini-cli';
  if (value === 'antigravity' || value === 'agy') return 'antigravity';
  throw new Error('--host must be claude, codex, gemini, or antigravity');
}

export function detectHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGENTIGRAM_HOST) return env.AGENTIGRAM_HOST;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_CI) return 'codex';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.GEMINI_CLI || env.GEMINI_CLI_HOME) return 'gemini';
  return undefined;
}

function sessionName(positional?: string, option?: string): string {
  if (positional && option && positional !== option) {
    throw new Error('pass the session name once, either positionally or with --session');
  }
  const selected = positional ?? option;
  if (!selected) {
    throw new Error('a session name is required (for example: agg create backend)');
  }
  return selected;
}

function verifyHost(value: InstallState['host']): void {
  // Antigravity runs embedded in the IDE — no standalone binary to probe.
  if (value === 'antigravity') return;
  const binary = value === 'codex' ? 'codex' : value === 'gemini-cli' ? 'gemini' : 'claude';
  // On Windows these are installed as `.cmd`/`.ps1` shims, which CreateProcess
  // will not resolve from a bare name — only the shell's PATHEXT search finds
  // them. Without `shell`, every Windows laptop fails this check with the agent
  // sitting right there on the PATH.
  const detected = spawnSync(binary, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  if (detected.error || detected.status !== 0) {
    throw new Error(`${binary} was not found on PATH; install it before joining`);
  }
}

/**
 * The Bare runtime that hosts the TUI. `apps/tui` installs with npm (bare-pack
 * traverses require() statically, which pnpm's symlinks break), so resolve
 * bare-runtime from that tree rather than the daemon's, and fall back to a
 * globally installed `bare` if the app's own dependencies are not there yet.
 */
function bareBinary(): string {
  try {
    const tuiRequire = createRequire(new URL('../../tui/package.json', import.meta.url));
    const binary = (tuiRequire('bare-runtime') as (referrer?: string) => string)();
    // The binary ships inside a platform package (bare-runtime-darwin-arm64 and
    // friends) as a plain file rather than a declared `bin`, so npm leaves it
    // non-executable when it lands as a nested dependency. Windows does not
    // care; macOS and Linux fail the spawn with EACCES.
    if (process.platform !== 'win32') {
      try {
        accessSync(binary, constants.X_OK);
      } catch {
        chmodSync(binary, statSync(binary).mode | 0o111);
      }
    }
    return binary;
  } catch {
    return 'bare';
  }
}

/**
 * Check the root before anything tries to run git in it.
 *
 * Node reports a missing `cwd` as ENOENT *on the command*, so a path that does
 * not exist surfaces as `spawnSync git ENOENT` — which reads as "git is not
 * installed" and sends people off to reinstall a working git. It is also the
 * first thing that happens on Windows when a shell does not expand `~`, since
 * the literal `~/work/demo` is then passed straight through.
 */
function verifyRepository(root: string): void {
  const absolute = resolve(root);
  if (!existsSync(absolute)) {
    throw new Error(
      `${absolute} does not exist.` +
        (root.includes('~')
          ? '\nPowerShell and cmd do not expand "~" for arguments passed to node. Use the full path.'
          : ''),
    );
  }
  if (!statSync(absolute).isDirectory()) throw new Error(`${absolute} is not a directory`);
  const git = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd: absolute,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  if (git.error) {
    throw new Error('git was not found on PATH; Agentigram needs it to identify the repository');
  }
  if (git.status !== 0) {
    throw new Error(`${absolute} is not a Git repository; clone or "git init" it first`);
  }
}

const REPOSITORY_FINGERPRINT_PREFIX = 'git-roots-v1:';

/**
 * A repository identity that survives host moves, renames, and different clone URLs.
 * Sorting also makes histories with multiple roots deterministic.
 */
export function fingerprintRepositoryRoots(roots: readonly string[]): string {
  const normalized = [...new Set(roots.map((root) => root.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join('\n');
  if (!normalized) throw new Error('repository has no commits; create an initial commit first');
  return `${REPOSITORY_FINGERPRINT_PREFIX}${createHash('sha256').update(normalized).digest('hex')}`;
}

export function repositoryFingerprint(root: string): string {
  const roots = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    cwd: resolve(root),
    encoding: 'utf8',
  }).split(/\s+/);
  return fingerprintRepositoryRoots(roots);
}

/**
 * Invites created before git-roots-v1 used the origin URL, which changes when
 * a repository is renamed or cloned through a different protocol. They cannot
 * be compared reliably after a rename, so keep them joinable. New invites use
 * the self-identifying prefix and are checked strictly against Git history.
 */
export function repositoryFingerprintMatches(local: string, invited: string): boolean {
  return !invited.startsWith(REPOSITORY_FINGERPRINT_PREFIX) || local === invited;
}

/** Poll until the process is gone, or give up — a stuck daemon must not block `leave`. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startDaemon(state: InstallState): void {
  const child = spawn(process.execPath, [executable, 'daemon', '--root', state.root], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  state.pid = child.pid;
  writeInstallState(state);
}

async function waitForDaemon(state: InstallState): Promise<Record<string, unknown>> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await requestIpc(state.socketPath, { type: 'status' }, DAEMON_POLL_MS);
      if (response.ok && response.output && typeof response.output === 'object') {
        return response.output as Record<string, unknown>;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, DAEMON_POLL_MS));
    }
  }
  throw new Error('daemon did not become ready; run `agg daemon --root <path>` to inspect logs');
}

async function startDaemonOrRollback(state: InstallState): Promise<Record<string, unknown>> {
  startDaemon(state);
  try {
    return await waitForDaemon(state);
  } catch (error) {
    if (state.pid) {
      try {
        process.kill(state.pid, 'SIGTERM');
        await waitForExit(state.pid);
      } catch {
        // A process that already exited is exactly what rollback needs.
      }
    }

    try {
      uninstall(state.root);
    } catch (rollbackError) {
      throw new Error(
        `daemon startup failed and automatic configuration rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
        { cause: error },
      );
    }

    throw new Error(
      `daemon startup failed; Agentigram restored the previous host configuration. ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}

export function buildProgram(invocationDirectory = process.env.INIT_CWD ?? process.cwd()): Command {
  const defaultRoot = resolve(invocationDirectory);
  const resolveRoot = (root: string) => resolveRepositoryRoot(root, defaultRoot);
  const program = new Command('agg')
    .description('Agentigram: autonomous coding-agent coordination across laptops.')
    .version('0.2.0');

  program
    .command('setup')
    .description('Install dependencies, warm the local model, and link the agg command.')
    .option('--skip-model', 'install without downloading the local model')
    .option('--skip-link', 'install without creating the global agg command')
    .action((options: { skipModel?: boolean; skipLink?: boolean }) => {
      const setup = fileURLToPath(new URL('../../../scripts/setup.mjs', import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          setup,
          ...(options.skipModel ? ['--skip-model'] : []),
          ...(options.skipLink ? ['--skip-link'] : []),
        ],
        { stdio: 'inherit' },
      );
      if (result.error) throw result.error;
      if (result.status) process.exitCode = result.status;
    });

  program
    .command('create [session]')
    .description('Create a P2P room on this authority laptop.')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--room <id>', 'room identifier', 'hackathon')
    .option('--session <id>', 'local agent session name (legacy form)')
    .option('--host <host>', 'claude, codex, gemini, or antigravity', detectHost())
    .option('--engineer <id>', 'engineer identifier')
    .action(
      async (
        session: string | undefined,
        options: {
          root: string;
          room: string;
          session?: string;
          host?: string;
          engineer?: string;
        },
      ) => {
        const root = resolveRoot(options.root);
        verifyRepository(root);
        const selectedHost = host(options.host);
        const selectedSession = sessionName(session, options.session);
        verifyHost(selectedHost);
        const state = install({
          root,
          roomId: options.room,
          mode: 'authority',
          host: selectedHost,
          sessionId: selectedSession,
          repositoryFingerprint: repositoryFingerprint(root),
          capability: createCapability(),
          engineerId: options.engineer,
        });
        const status = await startDaemonOrRollback(state);
        console.log(`Created room ${state.roomId}.`);
        console.log(`Invite: ${String(status.invite)}`);
        if (selectedHost === 'codex')
          console.log('Open /hooks in Codex and trust the Agentigram hooks.');
        if (selectedHost === 'gemini-cli')
          console.log(
            'Start Gemini CLI in this repository; Agentigram hooks and MCP are installed.',
          );
        if (selectedHost === 'antigravity')
          console.log(
            'Agentigram hooks and MCP are installed. Antigravity (agy) will coordinate automatically.',
          );
      },
    );

  program
    .command('join <invite> [session]')
    .description('Join a P2P room from another laptop.')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--session <id>', 'local agent session name (legacy form)')
    .option('--host <host>', 'claude, codex, gemini, or antigravity', detectHost())
    .option('--engineer <id>', 'engineer identifier')
    .action(
      async (
        inviteUri: string,
        session: string | undefined,
        options: { root: string; session?: string; host?: string; engineer?: string },
      ) => {
        const root = resolveRoot(options.root);
        verifyRepository(root);
        const invite = decodeInvite(inviteUri);
        const fingerprint = repositoryFingerprint(root);
        if (!repositoryFingerprintMatches(fingerprint, invite.repositoryFingerprint)) {
          throw new Error('this invite belongs to a different Git history');
        }
        const selectedHost = host(options.host);
        const selectedSession = sessionName(session, options.session);
        verifyHost(selectedHost);
        const state = install({
          root,
          roomId: invite.roomId,
          mode: 'peer',
          host: selectedHost,
          sessionId: selectedSession,
          // The room keeps its authority-issued identity. For a legacy invite
          // this is the old URL-based value; new invites equal `fingerprint`.
          repositoryFingerprint: invite.repositoryFingerprint,
          invite,
          engineerId: options.engineer,
        });
        await startDaemonOrRollback(state);
        console.log(`Joined room ${state.roomId} as ${state.sessionId}.`);
        if (selectedHost === 'codex')
          console.log('Open /hooks in Codex and trust the Agentigram hooks.');
        if (selectedHost === 'gemini-cli')
          console.log(
            'Start Gemini CLI in this repository; Agentigram hooks and MCP are installed.',
          );
        if (selectedHost === 'antigravity')
          console.log(
            'Agentigram hooks and MCP are installed. Antigravity (agy) will coordinate automatically.',
          );
      },
    );

  program
    .command('leave')
    .description('Stop Agentigram and restore local configuration exactly.')
    .option('--root <path>', 'repository root', defaultRoot)
    .action(async (options: { root: string }) => {
      const state = requiredState(resolveRoot(options.root));
      let stopped = false;
      try {
        const response = await requestIpc(state.socketPath, { type: 'shutdown' }, 1_000);
        stopped = response.ok;
      } catch {
        // Fall back to the stored PID for old or crashed daemons.
      }
      if (state.pid) {
        if (stopped) stopped = await waitForExit(state.pid);
        if (!stopped) {
          try {
            process.kill(state.pid, 'SIGTERM');
          } catch {
            // A stopped daemon does not prevent exact configuration restoration.
          }
          // Corestore holds an exclusive lock on its storage, and removing that
          // storage is part of leaving — so wait for the process to actually go
          // rather than racing it and failing with EBUSY.
          await waitForExit(state.pid);
        }
      }
      uninstall(state.root);
      console.log(`Left ${state.roomId}. Local configuration restored.`);
    });

  program
    .command('daemon')
    .description('Run the local daemon in the foreground.')
    .option('--root <path>', 'repository root', defaultRoot)
    .action(async (options: { root: string }) => {
      let daemon: LaptopDaemon;
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await daemon.stop();
        process.exit(0);
      };
      daemon = new LaptopDaemon(requiredState(resolveRoot(options.root)), () => void stop());
      await daemon.start();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });

  program
    .command('hook <event>')
    .description('Handle an agent-host hook payload from stdin.')
    .requiredOption('--root <path>', 'repository root')
    .action(async (event: string, options: { root: string }) => {
      try {
        const input = JSON.parse(await readStdin()) as never;
        const state = requiredState(resolveRoot(options.root));
        const response = await requestIpc(
          state.socketPath,
          { type: 'hook', event, input },
          event === 'PreToolUse' || event === 'BeforeTool'
            ? PRE_TOOL_TIMEOUT_MS
            : DEFAULT_HOOK_TIMEOUT_MS,
        );
        process.stdout.write(`${JSON.stringify(response.ok ? (response.output ?? {}) : {})}\n`);
      } catch (error) {
        process.stderr.write(
          `Agentigram hook unavailable: ${error instanceof Error ? error.message : error}\n`,
        );
        process.stdout.write('{}\n');
      }
    });

  program
    .command('mcp')
    .description('Run the MCP stdio shim that forwards to the local daemon.')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--session <id>', 'agent session id')
    .action(async (options: { root: string; session?: string }) => {
      const state = requiredState(resolveRoot(options.root));
      await runMcpServer(state.socketPath, options.session ?? state.sessionId);
    });

  program
    .command('status')
    .description('Show installation, authority, and room status.')
    .option('--root <path>', 'repository root', defaultRoot)
    .action(async (options: { root: string }) => {
      const state = readInstallState(resolveRoot(options.root));
      if (!state) return void console.log('Not joined.');
      try {
        const output = await waitForDaemon(state);
        console.log(JSON.stringify({ installed: true, daemon: true, ...output }, null, 2));
      } catch {
        console.log(
          JSON.stringify({ installed: true, daemon: false, roomId: state.roomId }, null, 2),
        );
      }
    });

  program
    .command('ui')
    .description('Open the desktop control window (read-only room view).')
    .option('--root <path>', 'repository root', defaultRoot)
    .action(async (options: { root: string }) => {
      const root = resolveRoot(options.root);
      verifyRepository(root);
      // Fail here rather than letting the window flash and vanish: "not joined"
      // and "no daemon" are both far better messages than an empty window.
      requiredState(root);
      let electron: string;
      try {
        electron = createRequire(import.meta.url)('electron') as string;
      } catch (error) {
        // pnpm skips Electron's postinstall unless the package is allowed to
        // build, so the module resolves while its binary was never downloaded.
        throw new Error(
          'the Electron binary is not installed. Run:\n' +
            '  pnpm rebuild electron\n' +
            'or, if that does not fetch it:\n' +
            '  node node_modules/.pnpm/electron@*/node_modules/electron/install.js\n' +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      const main = fileURLToPath(new URL('../ui/main.cjs', import.meta.url));
      const child = spawn(electron, [main], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, AGENTIGRAM_ROOT: root },
      });
      child.unref();
      console.log(`Control window opened for ${root}.`);
    });

  program
    .command('tui')
    .alias('start')
    .description('Open the Bare/Pear room view with on-device QVAC negotiation.')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--model <name>', 'QVAC model constant to load')
    .option('--ctx <tokens>', 'context window in tokens')
    .option('--verbose', 'log engine and native addon detail to stderr')
    .action(async (options: { root: string; model?: string; ctx?: string; verbose?: boolean }) => {
      const state = requiredState(resolveRoot(options.root));
      // Fail here rather than inside Bare: "not joined" is a far better message
      // than a socket error from a TUI that has already taken over the screen.
      await waitForDaemon(state);
      const entry = fileURLToPath(new URL('../../tui/bin.mjs', import.meta.url));
      const args = [
        entry,
        '--socket',
        state.socketPath,
        ...(options.model ? ['--model', options.model] : []),
        ...(options.ctx ? ['--ctx', options.ctx] : []),
        ...(options.verbose ? ['--verbose'] : []),
      ];
      // The TUI owns the terminal: inherit stdio and stay in the foreground.
      const child = spawn(bareBinary(), args, { stdio: 'inherit' });
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error) =>
          reject(
            new Error(
              `could not start Bare (${error.message}). Install it with ` +
                '`npm i -g bare-runtime`, or run `agg setup`.',
            ),
          ),
        );
        child.once('exit', (code) => {
          if (code) process.exitCode = code;
          resolve();
        });
      });
    });

  program
    .command('speech-test')
    .description('Download if needed, synthesize, and play one QVAC voice line.')
    .option('--text <sentence>', 'sentence to speak')
    .action(async (options: { text?: string }) => {
      const entry = fileURLToPath(new URL('../../tui/scripts/speech-test.js', import.meta.url));
      const child = spawn(bareBinary(), [entry, ...(options.text ? ['--text', options.text] : [])], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error) => reject(new Error(`could not start speech test: ${error.message}`)));
        child.once('exit', (code) => {
          if (code) process.exitCode = code;
          resolve();
        });
      });
    });

  program
    .command('run')
    .description('Run the local Codex or Claude agent and wake it for peer coordination.')
    .requiredOption('--autonomous', 'explicitly allow unattended managed agent turns')
    .requiredOption('--prompt <task>', 'initial task for the coding agent')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--new-session', 'discard the persisted host conversation before starting')
    .action(
      async (options: {
        autonomous: boolean;
        prompt: string;
        root: string;
        newSession?: boolean;
      }) => {
        if (!options.autonomous) throw new Error('managed runs require --autonomous');
        const root = resolveRoot(options.root);
        const state = requiredState(root);
        if (state.host !== 'codex' && state.host !== 'claude-code') {
          throw new Error(`managed runs support codex and claude-code, not ${state.host}`);
        }
        await waitForDaemon(state);
        const store = new RunnerStore(
          runtimePaths(root).base,
          `${runtimeKey(root)}-${state.roomId}-${state.sessionId}`,
          state.host,
        );
        const runner = new ManagedRunner({
          root,
          initialPrompt: options.prompt,
          newSession: options.newSession,
          adapter: createAdapter(state.host, { autonomous: true }),
          client: new IpcRunnerClient(state.socketPath, state.sessionId),
          store,
          spawn: spawnHost,
        });
        await runner.start();
        console.log(
          `Managing ${state.sessionId} with ${state.host}. Waiting for Agentigram messages…`,
        );
        await new Promise<void>((resolve) => {
          let stopping = false;
          const stop = async () => {
            if (stopping) return;
            stopping = true;
            await runner.stop();
            resolve();
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      },
    );

  program
    .command('log')
    .description('Read the replicated Hypercore this room is built from.')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--limit <count>', 'how many of the newest blocks to show', '20')
    .option('--json', 'print the raw blocks instead of one line each')
    .action(async (options: { root: string; limit: string; json?: boolean }) => {
      const state = requiredState(resolveRoot(options.root));
      // Through the daemon: Corestore holds an exclusive lock on its storage,
      // so opening the same core from here would fail while the room is up.
      const response = await requestIpc(
        state.socketPath,
        { type: 'corelog', limit: Number(options.limit) || 20 },
        5_000,
      );
      if (!response.ok) throw new Error(response.error);
      const log = response.output as {
        key: string;
        length: number;
        byteLength: number;
        writable: boolean;
        blocks: { index: number; raw: string }[];
      };
      if (options.json) {
        console.log(JSON.stringify(log, null, 2));
        return;
      }
      console.log(`core    ${log.key}`);
      console.log(
        `blocks  ${log.length} (${log.byteLength} bytes) · ${log.writable ? 'writable — this laptop is the authority' : 'read-only replica'}`,
      );
      console.log('');
      for (const entry of log.blocks) {
        let line = entry.raw;
        try {
          const event = JSON.parse(entry.raw) as {
            seq: number;
            ts: string;
            actor?: { sessionId?: string };
            payload: { type: string };
          };
          line = `${String(event.seq).padStart(4)}  ${event.ts}  ${(event.actor?.sessionId ?? '-').padEnd(10)} ${event.payload.type}`;
        } catch {
          // A block that is not an event still deserves to be shown.
        }
        console.log(`[${String(entry.index).padStart(4)}] ${line}`);
      }
    });

  program
    .command('demo')
    .description('Run the P2P coordination slice on one laptop.')
    .option('--scenario <name>', 'demo scenario', 'user-id-uuid')
    .option('--peers <count>', 'number of local peers', '4')
    .action(async (options: { scenario: string; peers: string }) => {
      if (options.scenario !== 'user-id-uuid') throw new Error('only user-id-uuid is available');
      const result = await runLocalDemo(Number(options.peers));
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('dev-connect')
    .description('Connect to the optional WebSocket coordinator or simulator.')
    .option('--url <url>', 'coordinator base URL', 'ws://localhost:8787')
    .option('--room <roomId>', 'room to join', 'hackathon')
    .option('--session <sessionId>', 'act as this session')
    .option('--token <token>', 'room token', 'dev')
    .option('--cursor-dir <dir>', 'where to persist the last seen seq')
    .option('--from-start', 'ignore the saved cursor and replay from seq 0')
    .action(
      (options: {
        url: string;
        room: string;
        session?: string;
        token: string;
        cursorDir?: string;
        fromStart?: boolean;
      }) => {
        const log = pino({ name: 'agentigram' }).child({ roomId: options.room });
        const cursor = CursorStore.forRoom(options.room, options.cursorDir);
        if (options.fromStart) cursor.reset();
        const client = new RoomClient({
          url: options.url,
          roomId: options.room,
          client: 'daemon',
          token: options.token,
          ...(options.session ? { sessionId: options.session } : {}),
          cursor,
          log,
          onWelcome: (state) => log.info({ seq: state.lastSeq }, 'welcome'),
          onEvents: (events) => {
            for (const event of events) log.info({ seq: event.seq }, summarise(event));
          },
        });
        client.start();
      },
    );

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) await main();
