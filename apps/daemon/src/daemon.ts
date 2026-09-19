import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { ClaudeCodeAdapter, type ClaudeHookInput } from '@clankergram/adapters';
import { parseToolCall } from '@clankergram/mcp';
import type { NewEvent } from '@clankergram/protocol';
import pino from 'pino';
import { CursorStore } from './cursor-store.js';
import type { InstallState } from './install.js';
import { createIpcServer, type IpcRequest, type IpcResponse } from './ipc.js';
import { RoomClient } from './room-client.js';
import { SymbolReader } from './symbol-reader.js';
import { WorktreeWatcher } from './watcher.js';

const SESSION_HEARTBEAT_MS = 10_000;
const AGENT_WRITE_MATCH_WINDOW_MS = 5_000;

function branch(root: string): string {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export class LaptopDaemon {
  private readonly log = pino({ name: 'clankergram-daemon' });
  private readonly sessions = new Set<string>();
  private readonly watchers = new Map<string, WorktreeWatcher>();
  private readonly recentAgentWrites = new Map<string, number>();
  private readonly symbols: SymbolReader;
  private readonly adapter: ClaudeCodeAdapter;
  private readonly client: RoomClient;
  private readonly server;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly state: InstallState) {
    this.symbols = new SymbolReader(state.root, this.log);
    this.adapter = new ClaudeCodeAdapter(async (paths, cwd) => this.symbols.read(paths, cwd));
    this.client = new RoomClient({
      url: state.coordinator,
      roomId: state.roomId,
      client: 'daemon',
      token: state.token ?? state.teamCode,
      cursor: CursorStore.forRoom(state.roomId),
      log: this.log,
      onEvents: (events) =>
        this.log.debug({ count: events.length, seq: events.at(-1)?.seq }, 'events applied'),
    });
    this.server = createIpcServer(state.socketPath, (request) => this.handle(request));
  }

  async start(): Promise<void> {
    this.client.start();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.state.socketPath, resolve);
    });
    this.heartbeat = setInterval(() => this.sendHeartbeats(), SESSION_HEARTBEAT_MS);
    this.log.info({ roomId: this.state.roomId, socket: this.state.socketPath }, 'daemon ready');
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const watcher of this.watchers.values()) await watcher.stop();
    this.client.stop();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.state.socketPath, { force: true });
  }

  private async handle(request: IpcRequest): Promise<IpcResponse> {
    if (request.type === 'status') {
      return { ok: true, output: { roomId: this.state.roomId, sessions: [...this.sessions] } };
    }
    if (request.type === 'tool')
      return this.handleTool(request.name, request.args, request.sessionId);
    const input = request.input as ClaudeHookInput;
    if (input.hook_event_name !== request.event) {
      return { ok: false, error: 'hook event does not match hook payload' };
    }
    const sessionId = input.session_id;
    if (input.hook_event_name === 'SessionStart') {
      this.sessions.add(sessionId);
      this.symbols.warm();
      await this.ensureWatcher(sessionId, input.cwd);
    }
    const events = await this.adapter.normalize(input, {
      roomId: this.state.roomId,
      engineerId: this.state.engineerId,
      sessionId,
      newId: () => crypto.randomUUID(),
      branch: branch(input.cwd),
      worktree: input.cwd,
    });
    for (const event of events) {
      if (event.payload.type === 'FILE_WRITE') {
        this.recordAgentWrite(event.payload.path);
        this.symbols.markDirty([event.payload.path]);
      }
      this.submit(event);
    }
    if (input.hook_event_name === 'SessionEnd') this.sessions.delete(sessionId);
    return { ok: true, output: {} };
  }

  private handleTool(name: string, args: unknown, sessionId: string): IpcResponse {
    const call = parseToolCall(name, args);
    if (call.name === 'sync') {
      return {
        ok: true,
        output: {
          roomId: this.state.roomId,
          activeSessions: [...this.sessions],
          note: 'Live coordination events are delivered by hooks as they arrive.',
        },
      };
    }
    const common = {
      id: crypto.randomUUID(),
      roomId: this.state.roomId,
      actor: { engineerId: this.state.engineerId, sessionId, kind: 'agent' as const },
      source: 'mcp' as const,
    };
    let event: NewEvent;
    switch (call.name) {
      case 'announce_intent':
        event = { ...common, payload: { type: 'INTENT', ...call.args } };
        break;
      case 'report': {
        const { kind, text, symbols } = call.args;
        event = {
          ...common,
          payload:
            kind === 'discovery'
              ? { type: 'DISCOVERY', text, symbols }
              : kind === 'blocker'
                ? { type: 'BLOCKER', text }
                : { type: 'BUG', text, symbols },
        };
        break;
      }
      case 'message_agent':
        event = { ...common, payload: { type: 'MESSAGE', ...call.args } };
        break;
      case 'propose':
        event = { ...common, payload: { type: 'PROPOSAL', ...call.args } };
        break;
      case 'respond':
        if (call.args.action === 'accept') {
          event = { ...common, payload: { type: 'ACCEPT', collisionId: call.args.collisionId } };
        } else if (call.args.contract) {
          event = {
            ...common,
            payload: {
              type: 'COUNTER',
              collisionId: call.args.collisionId,
              contract: call.args.contract,
              reason: call.args.reason ?? 'Counter-proposal',
            },
          };
        } else {
          return { ok: false, error: 'counter responses require a contract' };
        }
        break;
      case 'ask_context':
        event = {
          ...common,
          payload: {
            type: 'CONTEXT_QUERY',
            queryId: crypto.randomUUID(),
            toSession: call.args.session,
            question: call.args.question,
          },
        };
        break;
      case 'claim_complete':
        event = { ...common, payload: { type: 'COMPLETE_CLAIMED', summary: call.args.summary } };
        break;
      default:
        return { ok: false, error: `unsupported tool: ${name}` };
    }
    this.submit(event);
    return { ok: true, output: { accepted: true, eventId: event.id, type: event.payload.type } };
  }

  private submit(event: NewEvent): void {
    void this.client
      .submit(event)
      .catch((error) =>
        this.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'submit failed',
        ),
      );
  }

  private recordAgentWrite(path: string): void {
    const now = Date.now();
    for (const [candidate, writtenAt] of this.recentAgentWrites) {
      if (now - writtenAt > AGENT_WRITE_MATCH_WINDOW_MS) this.recentAgentWrites.delete(candidate);
    }
    this.recentAgentWrites.set(path, now);
  }

  private async ensureWatcher(sessionId: string, root: string): Promise<void> {
    if (this.watchers.has(root)) return;
    const watcher = new WorktreeWatcher({
      roomId: this.state.roomId,
      engineerId: this.state.engineerId,
      sessionId,
      root,
      submit: (event) => this.submit(event),
      onChange: (paths) => this.symbols.markDirty(paths),
      isRecentAgentWrite: (path) => {
        const writtenAt = this.recentAgentWrites.get(path);
        return writtenAt !== undefined && Date.now() - writtenAt <= AGENT_WRITE_MATCH_WINDOW_MS;
      },
      log: (message, error) =>
        this.log.debug({ err: error instanceof Error ? error.message : error }, message),
    });
    await watcher.start();
    this.watchers.set(root, watcher);
  }

  private sendHeartbeats(): void {
    for (const sessionId of this.sessions) {
      this.submit({
        id: crypto.randomUUID(),
        roomId: this.state.roomId,
        actor: { engineerId: this.state.engineerId, sessionId, kind: 'agent' },
        source: 'system',
        payload: { type: 'HEARTBEAT', sessionId },
      });
    }
  }
}
