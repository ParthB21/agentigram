import { NotImplementedError } from '@clankergram/protocol';
import { Command } from 'commander';
import pino from 'pino';
import { CursorStore } from './cursor-store.js';
import { RoomClient } from './room-client.js';
import { summarise } from './summary.js';

export function buildProgram(): Command {
  const program = new Command('clankergram')
    .description('Clankergram: coordination for coding agents on different laptops.')
    .version('0.0.0');

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
          onWelcome: (s) =>
            log.info({ seq: s.lastSeq, sessions: s.teamSummary.sessions }, 'welcome'),
          onEvents: (events) => {
            for (const e of events) log.info({ seq: e.seq, type: e.payload.type }, summarise(e));
          },
        });
        client.start();
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          process.on(signal, () => {
            client.stop();
            process.exit(0);
          });
        }
      },
    );

  for (const [name, description] of [
    [
      'join <teamCode>',
      'Authenticate, install agent hooks, register the MCP server, start the daemon.',
    ],
    ['mcp', 'Run the MCP stdio shim that forwards to the daemon socket.'],
  ] as const) {
    program
      .command(name)
      .description(`${description} (Part 2: not implemented yet)`)
      .action(() => {
        throw new NotImplementedError(`clankergram ${name.split(' ')[0]}`);
      });
  }
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) await main();
