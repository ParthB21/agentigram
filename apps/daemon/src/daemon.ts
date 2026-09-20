import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentAdapter,
  type AntigravityHookInput,
  AntigravityHookInputSchema,
  antigravityToolPaths,
  type ClaudeHookInput,
  ClaudeHookInputSchema,
  type CodexHookInput,
  CodexHookInputSchema,
  claudeToolPaths,
  codexToolPaths,
  createAdapter,
  type GeminiHookInput,
  GeminiHookInputSchema,
  geminiToolPaths,
  redactPayload,
  wrapPeerData,
} from '@agentigram/adapters';
import { parseToolCall } from '@agentigram/mcp';
import { P2PRoomTransport, type RoomTransport } from '@agentigram/p2p';
import {
  type Event,
  emptyRoomState,
  isAgentVisible,
  type NewEvent,
  NewEventSchema,
  type RoomState,
} from '@agentigram/protocol';
import { reduce, routeEvent } from '@agentigram/reducer';
import pino from 'pino';
import { AuthorityTransport } from './authority-transport.js';
import { CursorStore } from './cursor-store.js';
import type { InstallState } from './install.js';
import { createIpcServer, type IpcFrame, type IpcRequest, type IpcResponse } from './ipc.js';
import { isPipe } from './runtime.js';
import { summarise } from './summary.js';
import { SymbolReader } from './symbol-reader.js';
import { WorktreeWatcher } from './watcher.js';

const SESSION_HEARTBEAT_MS = 10_000;
const AGENT_WRITE_MATCH_WINDOW_MS = 5_000;
const MAX_INBOX_EVENTS = 20;
const ACTIONABLE_TYPES = new Set([
  'MESSAGE',
  'COLLISION',
  'LEASE_DENIED',
  'PROPOSAL',
  'COUNTER',
  'ACCEPT',
  'ESCALATE',
  'CONTEXT_PACKET',
  'CONTEXT_QUERY',
  'CONTEXT_ANSWER',
]);

type HookInput = ClaudeHookInput | CodexHookInput | GeminiHookInput | AntigravityHookInput;

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
  private readonly log = pino({ name: 'agentigram-daemon' });
  private readonly sessions = new Set<string>();
  private readonly watchers = new Map<string, WorktreeWatcher>();
  private readonly recentAgentWrites = new Map<string, number>();
  private readonly inbox = new Map<string, string[]>();
  private readonly subscribers = new Set<(frame: IpcFrame) => void>();
  private readonly symbols: SymbolReader;
  private readonly adapter: AgentAdapter;
  private readonly transport: RoomTransport;
  private readonly cursor;
  private roomState: RoomState;
  private readonly server;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly state: InstallState) {
    this.symbols = new SymbolReader(state.root, this.log);
    this.adapter = createAdapter(state.host);
    this.cursor = CursorStore.forRoom(state.roomId);
    this.roomState = emptyRoomState(state.roomId);
    this.transport =
      state.mode === 'authority'
        ? new AuthorityTransport(state)
        : new P2PRoomTransport({
            invite: requiredInvite(state),
            storage: join(state.p2pStorage, 'peer'),
            client: 'daemon',
            clientId: `${state.engineerId}:${state.sessionId}`,
            sessionId: state.sessionId,
            lastSeq: this.cursor.get(),
          });
    this.transport.onWelcome((roomState) => {
      this.roomState = roomState;
      this.cursor.set(roomState.lastSeq);
    });
    this.transport.onEvents((events) => this.receive(events));
    this.transport.onStatus((status) => this.log.info({ status }, 'transport status'));
    this.server = createIpcServer(
      state.socketPath,
      (request) => this.handle(request),
      (send) => this.addSubscriber(send),
    );
  }

  async start(): Promise<void> {
    await this.transport.start();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.state.socketPath, resolve);
    });
    await this.announceSession();
    this.heartbeat = setInterval(
      () => this.transport.heartbeat(this.state.sessionId),
      SESSION_HEARTBEAT_MS,
    );
    this.log.info(
      { roomId: this.state.roomId, socket: this.state.socketPath, mode: this.state.mode },
      'daemon ready',
    );
  }

  /**
   * Put this laptop in the room as soon as the daemon is up, rather than waiting
   * for the host's SessionStart hook.
   *
   * A heartbeat only refreshes a session that already exists, so without this a
   * host whose hooks are not firing — Codex before its project hooks are
   * trusted, or any host in the degraded watcher + MCP mode — stays invisible
   * to everyone else while looking healthy on its own machine. The hook, when
   * it does arrive, carries the real model and branch and simply updates it.
   */
  private async announceSession(): Promise<void> {
    if (this.roomState.sessions[this.state.sessionId]) return;
    try {
      await this.submit({
        id: crypto.randomUUID(),
        roomId: this.state.roomId,
        actor: {
          engineerId: this.state.engineerId,
          sessionId: this.state.sessionId,
          kind: 'agent',
        },
        source: 'hook',
        payload: {
          type: 'SESSION_STARTED',
          sessionId: this.state.sessionId,
          host: this.state.host,
          model: 'unknown',
          branch: branch(this.state.root),
        },
      });
    } catch (error) {
      // Not fatal: a peer whose authority is briefly unavailable still runs,
      // and the next hook or restart re-announces.
      this.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not announce this session',
      );
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const watcher of this.watchers.values()) await watcher.stop();
    await this.transport.stop();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // A Windows named pipe has no directory entry to remove; `unlink` on one
    // throws EINVAL, which `force` does not suppress. Closing the server is
    // what releases it.
    if (!isPipe(this.state.socketPath)) rmSync(this.state.socketPath, { force: true });
  }

  /** The room as the CLI and the TUI both see it. */
  private statusOutput(): Record<string, unknown> {
    const authority = this.transport instanceof AuthorityTransport ? this.transport : undefined;
    return {
      roomId: this.state.roomId,
      mode: this.state.mode,
      host: this.state.host,
      sessionId: this.state.sessionId,
      transport: this.transport.status,
      lastSeq: this.roomState.lastSeq,
      sessions: [...this.sessions],
      agents: Object.values(this.roomState.sessions),
      leases: Object.values(this.roomState.leases),
      collisions: Object.values(this.roomState.collisions).filter(
        (collision) => collision.status === 'open',
      ),
      negotiations: Object.values(this.roomState.negotiations),
      summary: this.roomState.teamSummary,
      ...(authority?.inviteUri ? { invite: authority.inviteUri } : {}),
    };
  }

  /**
   * Attach a room-view subscriber. It gets the current state immediately so a TUI that starts
   * late paints a full room rather than waiting for the next event.
   */
  private addSubscriber(send: (frame: IpcFrame) => void): () => void {
    this.subscribers.add(send);
    send({ t: 'state', state: this.statusOutput() });
    return () => this.subscribers.delete(send);
  }

  private broadcast(frame: IpcFrame): void {
    for (const send of this.subscribers) {
      try {
        send(frame);
      } catch {
        // A dead subscriber is dropped by its own socket close handler.
      }
    }
  }

  private async handle(request: IpcRequest): Promise<IpcResponse> {
    if (request.type === 'status') return { ok: true, output: this.statusOutput() };
    if (request.type === 'narrate') {
      // `PERSONA_LINES` is coordinator-authored: only the authority may put it
      // in the room. On a peer the dialogue stays local to that laptop's own
      // view, which is no loss — each laptop renders the room with its own
      // on-device model anyway, and the coordination that has to replicate
      // travels as PROPOSAL, not as prose.
      if (!(this.transport instanceof AuthorityTransport)) {
        return { ok: true, output: { accepted: true, replicated: false } };
      }
      await this.transport.submitAsAuthority({
        id: crypto.randomUUID(),
        roomId: this.state.roomId,
        actor: { engineerId: this.state.engineerId, kind: 'system' },
        source: 'system',
        payload: {
          type: 'PERSONA_LINES',
          lines: request.lines.map((line) => ({ ...line, seq: this.roomState.lastSeq })),
        },
      });
      return { ok: true, output: { accepted: true, replicated: true } };
    }
    // Intercepted by the IPC server, which keeps the socket open; it never reaches here.
    if (request.type === 'subscribe') return { ok: false, error: 'subscribe is a stream' };
    if (request.type === 'human') return this.handleHumanAction(request.action);
    if (request.type === 'tool')
      return this.handleTool(request.name, request.args, request.sessionId);

    const input = this.parseHook(request.input);
    if (input.hook_event_name !== request.event) {
      return { ok: false, error: 'hook event does not match hook payload' };
    }
    const sessionId = this.state.sessionId;
    if (
      input.hook_event_name === 'SessionStart' ||
      (this.state.host === 'gemini-cli' && input.hook_event_name === 'BeforeAgent')
    ) {
      this.sessions.add(sessionId);
      this.symbols.warm();
      await this.ensureWatcher(sessionId, input.cwd);
    }
    let contextOutput: object | undefined;
    if (input.hook_event_name === 'PreToolUse' || input.hook_event_name === 'BeforeTool') {
      const denial = this.editDenial(input);
      if (denial) {
        return {
          ok: true,
          output: preToolDecision('deny', denial, this.state.host === 'gemini-cli'),
        };
      }
      if (this.state.host !== 'gemini-cli') {
        const context = this.drainInbox(sessionId);
        if (context) contextOutput = hookContext('PreToolUse', context);
      }
    }
    if (input.hook_event_name === 'BeforeAgent') {
      const context = this.drainInbox(sessionId);
      if (context) contextOutput = hookContext('BeforeAgent', context);
    }
    if (input.hook_event_name === 'Stop') {
      const context = this.drainInbox(sessionId);
      if (context) {
        return {
          ok: true,
          output: {
            continue: false,
            stopReason: 'Agentigram has pending peer coordination',
            systemMessage: context,
          },
        };
      }
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
      const guarded = this.attachFencingToken(event);
      if (guarded.payload.type === 'FILE_WRITE') {
        this.recordAgentWrite(guarded.payload.path);
        this.symbols.markDirty([guarded.payload.path]);
      }
      await this.submit(this.attachReadSymbols(guarded, input.cwd));
    }
    if (input.hook_event_name === 'SessionEnd') this.sessions.delete(sessionId);
    if (input.hook_event_name === 'SessionStart') {
      return { ok: true, output: sessionContext(this.syncSummary()) };
    }
    if (contextOutput) return { ok: true, output: contextOutput };
    return { ok: true, output: {} };
  }

  private async handleHumanAction(
    action:
      | { type: 'release_lease'; leaseId: string }
      | { type: 'accept_escalation'; collisionId: string }
      | { type: 'escalate'; collisionId: string; reason: string },
  ): Promise<IpcResponse> {
    if (!(this.transport instanceof AuthorityTransport)) {
      return { ok: false, error: 'human decisions must be submitted on the authority laptop' };
    }
    const common = {
      id: crypto.randomUUID(),
      roomId: this.state.roomId,
      actor: { engineerId: this.state.engineerId, kind: 'human' as const },
      source: 'mcp' as const,
    };
    const event: NewEvent =
      action.type === 'release_lease'
        ? { ...common, payload: { type: 'LEASE_RELEASED', leaseId: action.leaseId } }
        : action.type === 'accept_escalation'
          ? { ...common, payload: { type: 'ACCEPT', collisionId: action.collisionId } }
          : {
              ...common,
              payload: {
                type: 'ESCALATE',
                collisionId: action.collisionId,
                reason: action.reason,
              },
            };
    const seq = await this.transport.submitAsHuman(event);
    return { ok: true, output: { seq } };
  }

  private async handleTool(name: string, args: unknown, sessionId: string): Promise<IpcResponse> {
    const call = parseToolCall(name, args);
    if (call.name === 'sync') return { ok: true, output: this.syncSummary() };
    const actingSession = sessionId || this.state.sessionId;
    const common = {
      id: crypto.randomUUID(),
      roomId: this.state.roomId,
      actor: {
        engineerId: this.state.engineerId,
        sessionId: actingSession,
        kind: 'agent' as const,
      },
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
    await this.submit(event);
    if (call.name === 'announce_intent' && call.args.symbols.length > 0) {
      await this.submit({
        ...common,
        id: crypto.randomUUID(),
        payload: { type: 'LEASE_REQUESTED', symbols: call.args.symbols, ttlMs: 10 * 60 * 1000 },
      });
    }
    if (call.name === 'claim_complete') {
      for (const lease of Object.values(this.roomState.leases)) {
        if (lease.sessionId === actingSession) {
          await this.submit({
            ...common,
            id: crypto.randomUUID(),
            payload: { type: 'LEASE_RELEASED', leaseId: lease.leaseId },
          });
        }
      }
    }
    return { ok: true, output: { accepted: true, eventId: event.id, type: event.payload.type } };
  }

  private parseHook(input: unknown): HookInput {
    if (this.state.host === 'codex') return CodexHookInputSchema.parse(input);
    if (this.state.host === 'gemini-cli') return GeminiHookInputSchema.parse(input);
    if (this.state.host === 'antigravity') return AntigravityHookInputSchema.parse(input);
    return ClaudeHookInputSchema.parse(input);
  }

  private receive(events: Event[]): void {
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= this.roomState.lastSeq) continue;
      this.roomState = reduce(this.roomState, event).state;
      this.cursor.set(event.seq);
      // Collisions are opened by the authority as it sequences events
      // (`AuthorityTransport.announceCollisions`), so they arrive here as
      // ordinary replicated events like any other.
      //
      // The room view sees everything this laptop sees, including dashboard-only types.
      this.broadcast({
        t: 'event',
        seq: event.seq,
        eventType: event.payload.type,
        ...(event.actor.sessionId ? { sessionId: event.actor.sessionId } : {}),
        text: summarise(event),
      });
      if (
        isAgentVisible(event.payload.type) &&
        ACTIONABLE_TYPES.has(event.payload.type) &&
        event.actor.sessionId !== this.state.sessionId &&
        routeEvent(this.roomState, event).includes(this.state.sessionId)
      ) {
        const current = this.inbox.get(this.state.sessionId) ?? [];
        current.push(summarise(event));
        this.inbox.set(this.state.sessionId, current.slice(-MAX_INBOX_EVENTS));
      }
    }
    // One state frame per batch, not per event: the room view only needs the settled result.
    if (events.length > 0) this.broadcast({ t: 'state', state: this.statusOutput() });
  }

  private editDenial(input: HookInput): string | undefined {
    const paths = (() => {
      if (this.state.host === 'codex') return codexToolPaths(input as CodexHookInput);
      if (this.state.host === 'gemini-cli') return geminiToolPaths(input as GeminiHookInput);
      if (this.state.host === 'antigravity') return antigravityToolPaths(input as AntigravityHookInput);
      return claudeToolPaths(input as ClaudeHookInput);
    })();
    for (const path of paths) {
      const lease = this.leaseForPath(path);
      if (lease && lease.sessionId !== this.state.sessionId) {
        return `${path} is leased by ${lease.sessionId}. Negotiate through Agentigram before editing.`;
      }
    }
    return undefined;
  }

  private attachFencingToken(event: NewEvent): NewEvent {
    if (event.payload.type !== 'FILE_WRITE') return event;
    const lease = this.leaseForPath(event.payload.path);
    return lease?.sessionId === this.state.sessionId
      ? { ...event, payload: { ...event.payload, fencingToken: lease.fencingToken } }
      : event;
  }

  private leaseForPath(path: string) {
    const normalised = normalisePath(path);
    return Object.values(this.roomState.leases).find((lease) =>
      lease.symbols.some((symbol) => normalisePath(symbol.split('#')[0] ?? '') === normalised),
    );
  }

  private drainInbox(sessionId: string): string | undefined {
    const lines = this.inbox.get(sessionId);
    if (!lines?.length) return undefined;
    this.inbox.delete(sessionId);
    return wrapPeerData({ from: 'room', kind: 'coordination', text: lines.join('\n') });
  }

  private syncSummary(): object {
    return {
      roomId: this.state.roomId,
      authority: this.transport.status,
      sessions: Object.values(this.roomState.sessions),
      leases: Object.values(this.roomState.leases),
      collisions: Object.values(this.roomState.collisions),
      negotiations: Object.values(this.roomState.negotiations),
      contracts: Object.values(this.roomState.contracts),
    };
  }

  /**
   * Resolve the symbols behind a file an agent just read.
   *
   * This is what separates a tier-1 collision from a tier-0 one: "you are
   * changing `User.id`, which Payments read" versus "you are both in user.ts".
   * Detection compares symbol keys, so a `FILE_READ` with no symbols can only
   * ever produce the weaker tier.
   *
   * Resolution is local and best-effort — a repo with no tsconfig, or a
   * non-TypeScript one, degrades to no symbols rather than failing the hook.
   * Only symbol keys ever leave this laptop, never file contents.
   */
  private attachReadSymbols(event: NewEvent, cwd: string): NewEvent {
    if (event.payload.type !== 'FILE_READ') return event;
    if (event.payload.symbols && event.payload.symbols.length > 0) return event;
    const symbols = this.symbols.read([event.payload.path], cwd);
    if (symbols.length === 0) return event;
    return { ...event, payload: { ...event.payload, symbols } };
  }

  private async submit(event: NewEvent): Promise<void> {
    try {
      const safe = NewEventSchema.parse({ ...event, payload: redactPayload(event.payload) });
      await this.transport.submit(safe);
    } catch (error) {
      this.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'submit failed',
      );
      throw error;
    }
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
      submit: (event) => void this.submit(this.attachFencingToken(event)),
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
}

function requiredInvite(state: InstallState) {
  if (!state.invite) throw new Error('peer installation is missing its room invite');
  if (state.invite.repositoryFingerprint !== state.repositoryFingerprint) {
    throw new Error('room invite belongs to a different repository');
  }
  return state.invite;
}

function normalisePath(path: string): string {
  return path.replaceAll('\\\\', '/').replace(/^\.\//, '');
}

function preToolDecision(decision: 'deny', reason: string, gemini = false): object {
  if (gemini) return { decision, reason };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

function hookContext(event: 'PreToolUse' | 'BeforeAgent', context: string): object {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

function sessionContext(summary: object): object {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: wrapPeerData({
        from: 'authority',
        kind: 'sync',
        text: JSON.stringify(summary),
      }),
    },
  };
}
