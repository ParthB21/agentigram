import { mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { ClaudeHookInputSchema, CodexHookInputSchema } from '@agentigram/adapters';
import { MCP_TOOL_NAMES } from '@agentigram/protocol';
import { z } from 'zod';
import { isPipe } from './runtime.js';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const PRE_TOOL_TIMEOUT_MS = 300;
export const DEFAULT_HOOK_TIMEOUT_MS = 1000;

const HookRequestSchema = z.object({
  type: z.literal('hook'),
  event: z.string(),
  input: z.union([ClaudeHookInputSchema, CodexHookInputSchema]),
});
const StatusRequestSchema = z.object({ type: z.literal('status') });
const HumanRequestSchema = z.object({
  type: z.literal('human'),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('release_lease'), leaseId: z.string().min(1) }),
    z.object({ type: z.literal('accept_escalation'), collisionId: z.string().min(1) }),
    z.object({
      type: z.literal('escalate'),
      collisionId: z.string().min(1),
      reason: z.string().min(1).max(500),
    }),
  ]),
});
const ToolRequestSchema = z.object({
  type: z.literal('tool'),
  name: z.enum(MCP_TOOL_NAMES),
  args: z.unknown(),
  sessionId: z.string().min(1),
});
export const IpcRequestSchema = z.discriminatedUnion('type', [
  HookRequestSchema,
  StatusRequestSchema,
  HumanRequestSchema,
  ToolRequestSchema,
]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type IpcResponse = { ok: true; output?: unknown } | { ok: false; error: string };

function collect(socket: Socket, onMessage: (raw: string) => void): void {
  let raw = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) socket.destroy(new Error('IPC request too large'));
    const newline = raw.indexOf('\n');
    if (newline >= 0) onMessage(raw.slice(0, newline));
  });
}

export function createIpcServer(
  socketPath: string,
  handle: (request: IpcRequest) => Promise<IpcResponse>,
): Server {
  if (!isPipe(socketPath)) {
    rmSync(socketPath, { force: true });
    mkdirSync(dirname(socketPath), { recursive: true });
  }
  return createServer((socket) => {
    collect(socket, async (raw) => {
      try {
        const request = IpcRequestSchema.parse(JSON.parse(raw));
        socket.end(`${JSON.stringify(await handle(request))}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.end(`${JSON.stringify({ ok: false, error: message } satisfies IpcResponse)}\n`);
      }
    });
  });
}

export function requestIpc(
  socketPath: string,
  request: IpcRequest,
  timeoutMs: number,
): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(new Error('daemon IPC timed out')), timeoutMs);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    collect(socket, (raw) => {
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(raw) as IpcResponse);
      } catch {
        reject(new Error('daemon returned invalid JSON'));
      }
    });
  });
}
