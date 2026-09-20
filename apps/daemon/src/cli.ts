import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
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
  return state;
}

function host(value: string): InstallState['host'] {
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'codex') return 'codex';
  if (value === 'gemini' || value === 'gemini-cli') return 'gemini-cli';
  if (value === 'antigravity' || value === 'agy') return 'antigravity';
  throw new Error('--host must be claude, codex, gemini, or antigravity');
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

function repositoryFingerprint(root: string): string {
  const absolute = resolve(root);
  let identity: string;
  try {
    identity = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: absolute,
      encoding: 'utf8',
    }).trim();
  } catch {
    identity = '';
  }
  if (!identity) {
    identity = `${basename(absolute)}:${execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: absolute, encoding: 'utf8' }).trim()}`;
  }
  return createHash('sha256')
    .update(identity.replace(/\.git$/, '').toLowerCase())
    .digest('hex');
}

/** Poll until the process is gone, or give up — a stuck daemon must not block `leave`. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  throw new Error(
    'daemon did not become ready; run `agentigram daemon --root <path>` to inspect logs',
  );
}

export function buildProgram(invocationDirectory = process.env.INIT_CWD ?? process.cwd()): Command {
  const defaultRoot = resolve(invocationDirectory);
  const resolveRoot = (root: string) => resolveRepositoryRoot(root, defaultRoot);
  const program = new Command('agentigram')
    .description('Agentigram: autonomous coding-agent coordination across laptops.')
    .version('0.2.0');

  program
    .command('create')
    .description('Create a P2P room on this authority laptop.')
    .option('--root <path>', 'repository root', defaultRoot)
    .option('--room <id>', 'room identifier', 'hackathon')
    .requiredOption('--session <id>', 'local agent session name')
    .option('--host <host>', 'claude, codex, gemini, or antigravity', 'claude')
    .option('--engineer <id>', 'engineer identifier')
    .action(
      async (options: {
        root: string;
        room: string;
        session: string;
        host: string;
        engineer?: string;
      }) => {
        const root = resolveRoot(options.root);
        verifyRepository(root);
        const selectedHost = host(options.host);
        verifyHost(selectedHost);
        const state = install({
          root,
          roomId: options.room,
          mode: 'authority',
          host: selectedHost,
          sessionId: options.session,
          repositoryFingerprint: repositoryFingerprint(root),
          capability: createCapability(),
          engineerId: options.engineer,
        });
        startDaemon(state);
        const status = await waitForDaemon(state);
        console.log(`Created room ${state.roomId}.`);
        console.log(`Invite: ${String(status.invite)}`);
        if (selectedHost === 'codex')
          console.log('Open /hooks in Codex and trust the Agentigram hooks.');
        if (selectedHost === 'gemini-cli')
          console.log('Start Gemini CLI in this repository; Agentigram hooks and MCP are installed.');
        if (selectedHost === 'antigravity')
          console.log('Agentigram hooks and MCP are installed. Antigravity (agy) will coordinate automatically.');
      },
    );

  program
    .command('join <invite>')
    .description('Join a P2P room from another laptop.')
    .option('--root <path>', 'repository root', defaultRoot)
    .requiredOption('--session <id>', 'local agent session name')
    .option('--host <host>', 'claude, codex, gemini, or antigravity', 'antigravity')
    .option('--engineer <id>', 'engineer identifier')
    .action(
      async (
        inviteUri: string,
        options: { root: string; session: string; host: string; engineer?: string },
      ) => {
        const root = resolveRoot(options.root);
        verifyRepository(root);
        const invite = decodeInvite(inviteUri);
        const fingerprint = repositoryFingerprint(root);
        if (fingerprint !== invite.repositoryFingerprint) {
          throw new Error('this invite belongs to a different Git repository');
        }
        const selectedHost = host(options.host);
        verifyHost(selectedHost);
        const state = install({
          root,
          roomId: invite.roomId,
          mode: 'peer',
          host: selectedHost,
          sessionId: options.session,
          repositoryFingerprint: fingerprint,
          invite,
          engineerId: options.engineer,
        });
        startDaemon(state);
        await waitForDaemon(state);
        console.log(`Joined room ${state.roomId} as ${state.sessionId}.`);
        if (selectedHost === 'codex')
          console.log('Open /hooks in Codex and trust the Agentigram hooks.');
        if (selectedHost === 'gemini-cli')
          console.log('Start Gemini CLI in this repository; Agentigram hooks and MCP are installed.');
        if (selectedHost === 'antigravity')
          console.log('Agentigram hooks and MCP are installed. Antigravity (agy) will coordinate automatically.');
      },
    );

  program
    .command('leave')
    .description('Stop Agentigram and restore local configuration exactly.')
    .option('--root <path>', 'repository root', defaultRoot)
    .action(async (options: { root: string }) => {
      const state = requiredState(resolveRoot(options.root));
      if (state.pid) {
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
      uninstall(state.root);
      console.log(`Left ${state.roomId}. Local configuration restored.`);
    });

  program
    .command('daemon')
    .description('Run the local daemon in the foreground.')
    .option('--root <path>', 'repository root', defaultRoot)
    .action(async (options: { root: string }) => {
      const daemon = new LaptopDaemon(requiredState(resolveRoot(options.root)));
      await daemon.start();
      const stop = async () => {
        await daemon.stop();
        process.exit(0);
      };
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
                '`npm i -g bare-runtime`, or run `npm install` in apps/tui.',
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
