import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import pino from 'pino';
import { CursorStore } from './cursor-store.js';
import { LaptopDaemon } from './daemon.js';
import { install, readInstallState, uninstall, writeInstallState } from './install.js';
import { DEFAULT_HOOK_TIMEOUT_MS, PRE_TOOL_TIMEOUT_MS, requestIpc } from './ipc.js';
import { runMcpServer } from './mcp-server.js';
import { RoomClient } from './room-client.js';
import { summarise } from './summary.js';

const executable = fileURLToPath(new URL('../bin/clankergram.mjs', import.meta.url));

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function requiredState(root: string) {
  const state = readInstallState(root);
  if (!state) throw new Error(`Clankergram is not joined in ${root}`);
  return state;
}

export function buildProgram(): Command {
  const program = new Command('clankergram')
    .description('Clankergram: coordination for coding agents on different laptops.')
    .version('0.1.0');

  program
    .command('join <teamCode>')
    .description('Install local Claude Code hooks and join a team room.')
    .option('--root <path>', 'repository root', process.cwd())
    .option('--coordinator <url>', 'coordinator URL', 'ws://localhost:8787')
    .option('--engineer <id>', 'engineer identifier')
    .option(
      '--token <secret>',
      'coordinator room secret (or CLANKERGRAM_TOKEN); default: the team code',
    )
    .action(
      (
        teamCode: string,
        opts: { root: string; coordinator: string; engineer?: string; token?: string },
      ) => {
        const detected = spawnSync('claude', ['--version'], { stdio: 'ignore' });
        if (detected.error || detected.status !== 0) {
          throw new Error('Claude Code was not found on PATH; install it before joining');
        }
        const state = install({
          root: opts.root,
          teamCode,
          coordinator: opts.coordinator,
          engineerId: opts.engineer,
          token: opts.token ?? process.env.CLANKERGRAM_TOKEN,
        });
        const child = spawn(process.execPath, [executable, 'daemon', '--root', state.root], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        state.pid = child.pid;
        writeInstallState(state);
        console.log(`Joined ${teamCode}. Daemon starting at ${state.socketPath}`);
      },
    );

  program
    .command('leave')
    .description('Stop Clankergram and restore local configuration exactly.')
    .option('--root <path>', 'repository root', process.cwd())
    .action((opts: { root: string }) => {
      const state = requiredState(resolve(opts.root));
      if (state.pid) {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {
          // The daemon already stopped; configuration still needs restoring.
        }
      }
      uninstall(state.root);
      console.log(`Left ${state.teamCode}. Local configuration restored.`);
    });

  program
    .command('daemon')
    .description('Run the local daemon in the foreground.')
    .option('--root <path>', 'repository root', process.cwd())
    .action(async (opts: { root: string }) => {
      const daemon = new LaptopDaemon(requiredState(resolve(opts.root)));
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
    .description('Handle a Claude Code hook payload from stdin.')
    .requiredOption('--root <path>', 'repository root')
    .action(async (event: string, opts: { root: string }) => {
      try {
        const input = JSON.parse(await readStdin()) as unknown;
        const state = requiredState(resolve(opts.root));
        const response = await requestIpc(
          state.socketPath,
          { type: 'hook', event, input: input as never },
          event === 'PreToolUse' ? PRE_TOOL_TIMEOUT_MS : DEFAULT_HOOK_TIMEOUT_MS,
        );
        process.stdout.write(`${JSON.stringify(response.ok ? (response.output ?? {}) : {})}\n`);
      } catch (error) {
        process.stderr.write(
          `Clankergram hook unavailable: ${error instanceof Error ? error.message : error}\n`,
        );
        process.stdout.write('{}\n');
      }
    });

  program
    .command('mcp')
    .description('Run the MCP stdio shim that forwards to the local daemon.')
    .option('--root <path>', 'repository root', process.cwd())
    .option(
      '--session <id>',
      'agent session id',
      process.env.CLAUDE_SESSION_ID ?? `mcp-${process.pid}`,
    )
    .action(async (opts: { root: string; session: string }) => {
      await runMcpServer(requiredState(resolve(opts.root)).socketPath, opts.session);
    });

  program
    .command('status')
    .description('Show local installation and daemon status.')
    .option('--root <path>', 'repository root', process.cwd())
    .action(async (opts: { root: string }) => {
      const state = readInstallState(resolve(opts.root));
      if (!state) {
        console.log('Not joined.');
        return;
      }
      try {
        const response = await requestIpc(state.socketPath, { type: 'status' }, 500);
        const output =
          response.ok && response.output && typeof response.output === 'object'
            ? response.output
            : {};
        console.log(JSON.stringify({ installed: true, daemon: response.ok, ...output }, null, 2));
      } catch {
        console.log(
          JSON.stringify({ installed: true, daemon: false, roomId: state.roomId }, null, 2),
        );
      }
    });

  program
    .command('dev-connect')
    .description('Connect to a coordinator (the simulator by default) and log its events.')
    .option('--url <url>', 'coordinator base URL', 'ws://localhost:8787')
    .option('--room <roomId>', 'room to join', 'hackathon')
    .option('--session <sessionId>', 'act as this session (default: none, observe only)')
    .option('--token <token>', 'auth token (the simulator accepts anything)', 'dev')
    .option('--cursor-dir <dir>', 'where to persist the last seen seq')
    .option('--from-start', 'ignore the saved cursor and replay from seq 0')
    .action(
      (opts: {
        url: string;
        room: string;
        session?: string;
        token: string;
        cursorDir?: string;
        fromStart?: boolean;
      }) => {
        const log = pino({ name: 'clankergram' }).child({
          roomId: opts.room,
          ...(opts.session ? { sessionId: opts.session } : {}),
        });
        const cursor = CursorStore.forRoom(opts.room, opts.cursorDir);
        if (opts.fromStart) cursor.reset();
        const client = new RoomClient({
          url: opts.url,
          roomId: opts.room,
          client: 'daemon',
          token: opts.token,
          ...(opts.session ? { sessionId: opts.session } : {}),
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
