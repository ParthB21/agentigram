import { mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  ClaudeHookInputSchema,
  CodexHookInputSchema,
  GeminiHookInputSchema,
} from '@agentigram/adapters';
import { MAX_MESSAGE_TEXT_LENGTH, MCP_TOOL_NAMES } from '@agentigram/protocol';
import { z } from 'zod';
import { isPipe } from './runtime.js';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/**
 * How long a write may wait for the daemon's verdict. A timeout here is no longer a free pass —
 * it denies the write — so it must comfortably outlast a busy laptop, and stay under the hosts'
 * own 10 s hook limit.
 */
export const PRE_TOOL_TIMEOUT_MS = 3000;
export const DEFAULT_HOOK_TIMEOUT_MS = 1000;

const HookRequestSchema = z.object({
  type: z.literal('hook'),
  event: z.string(),
  input: z.union([ClaudeHookInputSchema, CodexHookInputSchema, GeminiHookInputSchema]),
});
const StatusRequestSchema = z.object({ type: z.literal('status') });
/** Ask the daemon to publish its departure and shut down cleanly. */
const ShutdownRequestSchema = z.object({ type: z.literal('shutdown') });
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
const RunnerRegisterRequestSchema = z.object({
  type: z.literal('runner_register'),
  sessionId: z.string().min(1),
  autonomous: z.boolean(),
});
const RunnerUnregisterRequestSchema = z.object({
  type: z.literal('runner_unregister'),
  sessionId: z.string().min(1),
});
const RunnerClaimRequestSchema = z.object({
  type: z.literal('runner_claim'),
  sessionId: z.string().min(1),
});
const RunnerRequeueRequestSchema = z.object({
  type: z.literal('runner_requeue'),
  sessionId: z.string().min(1),
  claimId: z.string().min(1),
});
const RunnerCompleteRequestSchema = z
  .object({
    type: z.literal('runner_complete'),
    sessionId: z.string().min(1),
    claimId: z.string().min(1),
    outcome: z.enum(['acted', 'no_action', 'blocked']),
    reply: z
      .object({
        to: z.string().min(1).max(128),
        text: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
      })
      .optional(),
  })
  .superRefine((request, context) => {
    if (request.outcome !== 'no_action' && !request.reply) {
      context.addIssue({ code: 'custom', message: `${request.outcome} requires a reply` });
    }
    if (request.outcome === 'no_action' && request.reply) {
      context.addIssue({ code: 'custom', message: 'no_action cannot include a reply' });
    }
  });
/** Opens a long-lived stream of room frames instead of a single reply. Used by the Bare/Pear TUI. */
const SubscribeRequestSchema = z.object({ type: z.literal('subscribe') });
/**
 * Read the replicated Hypercore. It goes through the daemon because Corestore
 * takes an exclusive lock on its storage — nothing else can open the same core
 * while the daemon is running.
 */
const CoreLogRequestSchema = z.object({
  type: z.literal('corelog'),
  limit: z.number().int().positive().max(1000).optional(),
});
/**
 * Dialogue rendered by the local QVAC model. `PERSONA_LINES` is dashboard-only (CLAUDE.md rule 5),
 * so an on-device model's prose reaches the room view and never an agent's context.
 */
const NarrateRequestSchema = z.object({
  type: z.literal('narrate'),
  lines: z
    .array(z.object({ speaker: z.string().min(1), text: z.string().min(1).max(2000) }))
    .min(1)
    .max(20),
});
/**
 * Read the room's work allocation, or force a fresh one. Authority-only: the planner sees the
 * whole room, and a peer would only ever allocate against a partial picture.
 */
const PlanRequestSchema = z.object({
  type: z.literal('plan'),
  replan: z.boolean().optional(),
});
/**
 * A git action the hooks cannot see. Claude Code reports `git commit` only as the shell command
 * that ran; the repository's own `prepare-commit-msg` hook reports what it actually touched.
 */
const GitRequestSchema = z.object({
  type: z.literal('git'),
  action: z.enum(['commit']),
  paths: z.array(z.string().min(1)).max(200),
});
export const IpcRequestSchema = z.discriminatedUnion('type', [
  HookRequestSchema,
  PlanRequestSchema,
  GitRequestSchema,
  StatusRequestSchema,
  ShutdownRequestSchema,
  HumanRequestSchema,
  ToolRequestSchema,
  RunnerRegisterRequestSchema,
  RunnerUnregisterRequestSchema,
  RunnerClaimRequestSchema,
  RunnerRequeueRequestSchema,
  RunnerCompleteRequestSchema,
  SubscribeRequestSchema,
  NarrateRequestSchema,
  CoreLogRequestSchema,
]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type IpcResponse = { ok: true; output?: unknown } | { ok: false; error: string };

/** A frame pushed down a subscribed socket. Newline-delimited JSON, same framing as requests. */
export type IpcFrame =
  | { t: 'state'; state: unknown }
  | {
      t: 'event';
      seq: number;
      eventType: string;
      sessionId?: string;
      text: string;
      speech?: { speaker: string; text: string; priority: 0 | 1 | 2 | 3 };
    }
  | { t: 'wake'; sessionId: string; seq: number };

/**
 * Newline-delimited JSON. Consumes each complete line and keeps the remainder buffered, so a
 * subscriber can keep the socket open for many frames and a request split across TCP chunks still
 * parses.
 */
function collect(socket: Socket, onMessage: (raw: string) => void): void {
  let raw = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) {
      socket.destroy(new Error('IPC request too large'));
      return;
    }
    let newline = raw.indexOf('\n');
    while (newline >= 0) {
      const line = raw.slice(0, newline);
      raw = raw.slice(newline + 1);
      if (line.trim()) onMessage(line);
      newline = raw.indexOf('\n');
    }
  });
}

export function createIpcServer(
  socketPath: string,
  handle: (request: IpcRequest) => Promise<IpcResponse>,
  onSubscribe?: (send: (frame: IpcFrame) => void) => () => void,
): Server {
  if (!isPipe(socketPath)) {
    rmSync(socketPath, { force: true });
    mkdirSync(dirname(socketPath), { recursive: true });
  }
  return createServer((socket) => {
    let unsubscribe: (() => void) | undefined;
    const release = () => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
    socket.on('close', release);
    socket.on('error', release);

    collect(socket, async (raw) => {
      try {
        const request = IpcRequestSchema.parse(JSON.parse(raw));
        if (request.type === 'subscribe') {
          if (!onSubscribe) throw new Error('this daemon does not support subscriptions');
          // Already streaming: a second subscribe on one socket would double every frame.
          if (unsubscribe) return;
          unsubscribe = onSubscribe((frame) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
          });
          return;
        }
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
