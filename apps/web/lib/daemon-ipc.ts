import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EventSchema, RoomStateSchema } from '@agentigram/protocol';
import { z } from 'zod';

const IPC_TIMEOUT_MS = 1_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const InstallStateSchema = z.object({
  root: z.string().min(1),
  roomId: z.string().min(1),
  socketPath: z.string().min(1),
});

const DaemonStatusSchema = z.object({
  roomId: z.string().min(1),
  transport: z.enum(['connecting', 'connected', 'read-only', 'closed']),
  roomState: RoomStateSchema,
  events: z.array(EventSchema),
});

const IpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), output: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

function repositoryRoot(start = process.cwd()): string {
  if (process.env.AGENTIGRAM_ROOT) return resolve(process.env.AGENTIGRAM_ROOT);
  let candidate = resolve(start);
  for (;;) {
    if (existsSync(join(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('Could not locate the Agentigram repository root');
    candidate = parent;
  }
}

function installState(root: string) {
  const key = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  const path = join(homedir(), '.agentigram', 'installations', `${key}.json`);
  if (!existsSync(path)) throw new Error(`Agentigram is not joined in ${root}`);
  return InstallStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function requestStatus(socketPath: string): Promise<DaemonStatus> {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection(socketPath);
    let raw = '';
    let settled = false;
    const finish = (error?: Error, status?: DaemonStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (status) resolveStatus(status);
    };
    const timer = setTimeout(
      () => finish(new Error('Agentigram daemon did not respond')),
      IPC_TIMEOUT_MS,
    );
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'status' })}\n`));
    socket.once('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_RESPONSE_BYTES) {
        finish(new Error('Agentigram daemon response was too large'));
        return;
      }
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = IpcResponseSchema.parse(JSON.parse(raw.slice(0, newline)));
        if (!response.ok) finish(new Error(response.error));
        else {
          const status = DaemonStatusSchema.safeParse(response.output);
          if (!status.success) {
            finish(new Error('Agentigram daemon needs to be restarted to enable the live bridge'));
          } else {
            finish(undefined, status.data);
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid daemon response'));
      }
    });
  });
}

export async function readLocalDaemonStatus(teamId: string): Promise<DaemonStatus> {
  const state = installState(repositoryRoot());
  if (state.roomId !== teamId) {
    throw new Error(`Local daemon is joined to ${state.roomId}, not ${teamId}`);
  }
  return requestStatus(state.socketPath);
}
