import { execFileSync } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import { type CoreLogReader, P2PRoomTransport, type RoomTransport } from '@agentigram/p2p';
import {
  type Event,
  emptyRoomState,
  MAX_AUTOMATION_DEPTH,
  type NewEvent,
  NewEventSchema,
  type RoomState,
} from '@agentigram/protocol';
import { reduce, routeEvent, sessionPresence } from '@agentigram/reducer';
import pino from 'pino';
import { AuthorityTransport } from './authority-transport.js';
import { autonomousDenial } from './autonomous-guard.js';
import { CursorStore } from './cursor-store.js';
import { isRepeatedPresence, speechMetadata } from './event-rendering.js';
import { isFreshEvent, shouldRouteToInbox, shouldWake, WakeInbox } from './inbox.js';
import type { InstallState } from './install.js';
import { createIpcServer, type IpcFrame, type IpcRequest, type IpcResponse } from './ipc.js';
import { freezeDenial } from './orchestrator/freeze.js';
import { OllamaClient } from './orchestrator/ollama.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { isPipe } from './runtime.js';
import { summarise } from './summary.js';
import { SymbolReader } from './symbol-reader.js';
import { WorktreeWatcher } from './watcher.js';

const SESSION_HEARTBEAT_MS = 10_000;
/**
 * How long after its last real event a session is still called "working".
 *
 * Activity is derived from the replicated event stream rather than stored on
 * the session, so every laptop reaches the same answer without a new event type
 * — and a session that simply stopped, crashed or was closed decays to idle on
 * its own instead of advertising a task it finished ten minutes ago.
 */
const IDLE_AFTER_MS = 45_000;
/** How often the room view is refreshed so idleness becomes visible. */
const IDLE_TICK_MS = 5_000;
/** Do not let a broken authority make graceful shutdown hang indefinitely. */
const SESSION_END_TIMEOUT_MS = 1_500;
/** Liveness, not work. A heartbeat must not make an idle agent look busy. */
const ACTIVITY_IGNORED = new Set(['HEARTBEAT', 'PERSONA_LINES', 'SESSION_ENDED']);
const AGENT_WRITE_MATCH_WINDOW_MS = 5_000;
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
  private readonly inbox = new WakeInbox();
  private readonly subscribers = new Set<(frame: IpcFrame) => void>();
  /** sessionId -> when it last did something, and what. Derived, never stored. */
  private readonly activity = new Map<string, { at: number; what: string }>();
  private readonly symbols: SymbolReader;
  private readonly adapter: AgentAdapter;
  private readonly transport: RoomTransport;
  private readonly cursor;
  private roomState: RoomState;
  private readonly server;
  private heartbeat: NodeJS.Timeout | undefined;
  private idleTick: NodeJS.Timeout | undefined;
  private sessionAnnouncement: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private runnerRegistered = false;
  private managedAutonomy = false;

  constructor(
    private readonly state: InstallState,
    private readonly requestShutdown: () => void = () => {},
  ) {
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
      this.broadcast({ t: 'state', state: this.statusOutput() });
      // WELCOME is the first point at which a peer is authenticated. Announce
      // once per completed handshake so a daemon restart is always a visible
      // rejoin, even while the previous heartbeat still looks fresh.
      this.sessionAnnouncement = this.announceSession();
    });
    this.transport.onEvents((events) => this.receive(events));
    this.transport.onStatus((status) => {
      this.log.info({ status }, 'transport status');
      this.broadcast({ t: 'state', state: this.statusOutput() });
    });
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
    // Authority mode welcomes synchronously during transport.start(). Peers
    // that are already connected do too; disconnected peers announce from the
    // WELCOME callback whenever the connection becomes available.
    await this.sessionAnnouncement;
    this.startOrchestrator();
    this.heartbeat = setInterval(
      () => this.transport.heartbeat(this.state.sessionId),
      SESSION_HEARTBEAT_MS,
    );
    // Going idle is the absence of events, so nothing would ever push it. Tick
    // the room view instead, and only while something is watching.
    this.idleTick = setInterval(() => {
      if (this.subscribers.size > 0) this.broadcast({ t: 'state', state: this.statusOutput() });
    }, IDLE_TICK_MS);
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
      // and WELCOME on the next reconnect retries the announcement.
      this.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not announce this session',
      );
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    clearInterval(this.heartbeat);
    clearInterval(this.idleTick);
    for (const watcher of this.watchers.values()) await watcher.stop();
    await this.announceSessionEnded();
    await this.transport.stop();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // A Windows named pipe has no directory entry to remove; `unlink` on one
    // throws EINVAL, which `force` does not suppress. Closing the server is
    // what releases it.
    if (!isPipe(this.state.socketPath)) rmSync(this.state.socketPath, { force: true });
  }

  private async announceSessionEnded(): Promise<void> {
    const session = this.roomState.sessions[this.state.sessionId];
    if (!session || session.status === 'ended') return;
    const event: NewEvent = {
      id: crypto.randomUUID(),
      roomId: this.state.roomId,
      actor: {
        engineerId: this.state.engineerId,
        sessionId: this.state.sessionId,
        kind: 'agent',
      },
      source: 'hook',
      payload: {
        type: 'SESSION_ENDED',
        sessionId: this.state.sessionId,
        reason: 'daemon_stopped',
      },
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.submit(event),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('session end acknowledgement timed out')),
            SESSION_END_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not announce session end',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Note what a session just did, for the "working on X / idle" line in the
   * room view. Derived from the replicated stream, so every laptop agrees.
   */
  private recordActivity(event: Event): void {
    const sessionId = event.actor.sessionId;
    if (!sessionId) return;
    const payload = event.payload;
    if (ACTIVITY_IGNORED.has(payload.type)) return;
    const at = Date.parse(event.ts) || Date.now();
    this.activity.set(sessionId, { at, what: describeActivity(payload) });
  }

  /** Which sessions are working right now, and at what. */
  private activitySnapshot(): Record<string, { what: string; sinceMs: number }> {
    const now = Date.now();
    const out: Record<string, { what: string; sinceMs: number }> = {};
    for (const [sessionId, seen] of this.activity) {
      const sinceMs = now - seen.at;
      if (sinceMs <= IDLE_AFTER_MS) out[sessionId] = { what: seen.what, sinceMs };
    }
    return out;
  }

  /**
   * live / stale / ended per session.
   *
   * A session only reaches `ended` if its host fired SessionEnd, which a laptop
   * that was closed, crashed or lost the network never gets to do. `stale` —
   * no heartbeat for a while — is what covers those, and it is the difference
   * between "that agent is thinking" and "that agent is gone".
   */
  private presenceSnapshot(): Record<string, string> {
    const now = Date.now();
    const out: Record<string, string> = {};
    for (const sessionId of Object.keys(this.roomState.sessions)) {
      out[sessionId] = sessionPresence(this.roomState, sessionId, now) ?? 'stale';
    }
    return out;
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
      // The roster is current presence, not an append-only session history.
      // Departure remains visible in the event feed while the row disappears.
      agents: Object.values(this.roomState.sessions).filter(
        (session) => session.status !== 'ended',
      ),
      leases: Object.values(this.roomState.leases),
      collisions: Object.values(this.roomState.collisions).filter(
        (collision) => collision.status === 'open',
      ),
      negotiations: Object.values(this.roomState.negotiations),
      activity: this.activitySnapshot(),
      presence: this.presenceSnapshot(),
      summary: this.roomState.teamSummary,
      runner: { registered: this.runnerRegistered, autonomous: this.managedAutonomy },
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
    if (request.type === 'shutdown') {
      // Let IPC write the acknowledgement before stop() closes the server.
      setImmediate(this.requestShutdown);
      return { ok: true, output: { shuttingDown: true } };
    }
    if (request.type === 'runner_register') {
      if (request.sessionId !== this.state.sessionId) return this.wrongRunnerSession();
      this.runnerRegistered = true;
      this.managedAutonomy = request.autonomous;
      return { ok: true, output: { registered: true, autonomous: request.autonomous } };
    }
    if (request.type === 'runner_unregister') {
      if (request.sessionId !== this.state.sessionId) return this.wrongRunnerSession();
      this.runnerRegistered = false;
      this.managedAutonomy = false;
      return { ok: true, output: { registered: false } };
    }
    if (request.type === 'runner_claim') {
      if (request.sessionId !== this.state.sessionId) return this.wrongRunnerSession();
      return { ok: true, output: this.inbox.claim(request.sessionId) ?? null };
    }
    if (request.type === 'runner_requeue') {
      if (request.sessionId !== this.state.sessionId) return this.wrongRunnerSession();
      return this.inbox.requeue(request.sessionId, request.claimId)
        ? { ok: true, output: { requeued: true } }
        : { ok: false, error: 'runner claim was not found' };
    }
    if (request.type === 'runner_complete') return this.completeRunnerClaim(request);
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
    if (request.type === 'corelog') {
      const transport = this.transport as Partial<CoreLogReader>;
      if (!transport.readCoreLog) {
        return { ok: false, error: 'this transport has no replicated log' };
      }
      return { ok: true, output: await transport.readCoreLog(request.limit) };
    }
    if (request.type === 'human') return this.handleHumanAction(request.action);
    if (request.type === 'tool')
      return this.handleTool(request.name, request.args, request.sessionId);

    // Set AGENTIGRAM_HOOK_LOG=<file> to capture what a host actually sends.
    // Hook payload shapes differ between hosts and move between releases, and
    // guessing at one is how an adapter ends up silently dropping reads.
    if (process.env.AGENTIGRAM_HOOK_LOG) {
      try {
        appendFileSync(
          process.env.AGENTIGRAM_HOOK_LOG,
          `${JSON.stringify({ host: this.state.host, event: request.event, input: request.input })}\n`,
        );
      } catch {
        // Diagnostics must never break a hook.
      }
    }
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
    // Publish without blocking the hook's reply. Nothing the host is waiting
    // for depends on the event reaching the room, and resolving the symbols
    // behind a read means querying the TypeScript index — easily longer than a
    // host will wait. A hook that overruns has its output discarded, which is
    // what was dropping reads and leaving every read set empty. The daemon
    // outlives the hook process, so the work still completes.
    for (const event of events) {
      const guarded = this.attachFencingToken(event);
      if (guarded.payload.type === 'FILE_WRITE') {
        this.recordAgentWrite(guarded.payload.path);
        this.symbols.markDirty([guarded.payload.path]);
      }
      void this.publishObserved(guarded, input.cwd);
    }
    if (input.hook_event_name === 'SessionEnd') this.sessions.delete(sessionId);
    if (input.hook_event_name === 'SessionStart') {
      return { ok: true, output: sessionContext(this.syncSummary()) };
    }
    if (contextOutput) return { ok: true, output: contextOutput };
    return { ok: true, output: {} };
  }

  private wrongRunnerSession(): IpcResponse {
    return { ok: false, error: 'runner session does not match this daemon' };
  }

  private async completeRunnerClaim(
    request: Extract<IpcRequest, { type: 'runner_complete' }>,
  ): Promise<IpcResponse> {
    if (request.sessionId !== this.state.sessionId) return this.wrongRunnerSession();
    const claim = this.inbox.claimed(request.sessionId, request.claimId);
    if (!claim) return { ok: false, error: 'runner claim was not found' };
    if (request.outcome === 'no_action') {
      this.inbox.complete(request.sessionId, request.claimId);
      return { ok: true, output: { completed: true, replied: false } };
    }
    const first = claim.items[0];
    if (!first || !request.reply) return { ok: false, error: 'runner claim has no reply context' };
    if (request.reply.to !== first.from) {
      return { ok: false, error: 'managed replies must return to the originating session' };
    }
    const automationDepth = Math.max(...claim.items.map((item) => item.automationDepth)) + 1;
    if (automationDepth > MAX_AUTOMATION_DEPTH) {
      return { ok: false, error: 'managed reply exceeds the automation depth limit' };
    }
    const causedBy = claim.items.at(-1)?.seq;
    await this.submit({
      id: crypto.randomUUID(),
      roomId: this.state.roomId,
      actor: {
        engineerId: this.state.engineerId,
        sessionId: this.state.sessionId,
        kind: 'agent',
      },
      ...(causedBy !== undefined ? { causedBy } : {}),
      source: 'mcp',
      payload: {
        type: 'MESSAGE',
        to: request.reply.to,
        text: request.reply.text,
        conversationId: first.conversationId,
        ...(causedBy !== undefined ? { replyToSeq: causedBy } : {}),
        automationDepth,
        ...(request.outcome === 'blocked' ? { automationTerminal: true } : {}),
      },
    });
    this.inbox.complete(request.sessionId, request.claimId);
    return { ok: true, output: { completed: true, replied: true, automationDepth } };
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
    const now = Date.now();
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= this.roomState.lastSeq) continue;
      // Presence is judged against the room as it was a moment ago: whether an arrival is news
      // is exactly the question of what this event changed.
      const before = this.roomState;
      this.roomState = reduce(before, event).state;
      this.cursor.set(event.seq);
      this.recordActivity(event);
      // Collisions are opened by the authority as it sequences events
      // (`AuthorityTransport.announceCollisions`), so they arrive here as
      // ordinary replicated events like any other.
      //
      // The room view sees everything this laptop sees, including dashboard-only types.
      const speakable = isFreshEvent(event, now) && !isRepeatedPresence(before, event);
      const speech = speakable ? speechMetadata(event) : undefined;
      this.broadcast({
        t: 'event',
        seq: event.seq,
        eventType: event.payload.type,
        ...(event.actor.sessionId ? { sessionId: event.actor.sessionId } : {}),
        text: summarise(event),
        ...(speech ? { speech } : {}),
      });
      const routedSessions = routeEvent(this.roomState, event);
      const wake = shouldWake(event, this.state.sessionId, routedSessions, now);
      if (shouldRouteToInbox(event, this.state.sessionId, routedSessions, now)) {
        this.inbox.enqueue(this.state.sessionId, event, wake);
      }
      if (wake) {
        this.broadcast({ t: 'wake', sessionId: this.state.sessionId, seq: event.seq });
      }
    }
    // One state frame per batch, not per event: the room view only needs the settled result.
    if (events.length > 0) this.broadcast({ t: 'state', state: this.statusOutput() });
  }

  private editDenial(input: HookInput): string | undefined {
    const paths = (() => {
      if (this.state.host === 'codex') return codexToolPaths(input as CodexHookInput);
      if (this.state.host === 'gemini-cli') return geminiToolPaths(input as GeminiHookInput);
      if (this.state.host === 'antigravity')
        return antigravityToolPaths(input as AntigravityHookInput);
      return claudeToolPaths(input as ClaudeHookInput);
    })();
    if (this.managedAutonomy) {
      const denied = autonomousDenial({
        root: this.state.root,
        cwd: input.cwd,
        paths,
        command: shellCommand(input),
      });
      if (denied) return denied;
    }
    for (const path of paths) {
      const frozen = freezeDenial(this.roomState, this.state.sessionId, path);
      if (frozen) return frozen;
      const lease = this.leaseForPath(path);
      if (lease && lease.sessionId !== this.state.sessionId) {
        return `${path} is leased by ${lease.sessionId}. Negotiate through Agentigram before editing.`;
      }
    }
    return undefined;
  }

  /**
   * The orchestrator debates collisions, so it lives where collisions are opened: the authority.
   * On unless `AGENTIGRAM_ORCHESTRATOR=off`. It uses local Ollama when it answers and scripted
   * turns when it does not (`AGENTIGRAM_ORCHESTRATOR=scripted` skips Ollama entirely).
   */
  private startOrchestrator(): void {
    const mode = process.env.AGENTIGRAM_ORCHESTRATOR ?? 'on';
    if (mode === 'off' || !(this.transport instanceof AuthorityTransport)) return;
    const transport = this.transport;
    const orchestrator = new Orchestrator(
      {
        roomId: this.state.roomId,
        engineerId: this.state.engineerId,
        state: () => this.roomState,
        submit: (event) =>
          transport.submitAsAuthority({ ...event, payload: redactPayload(event.payload) }),
        log: this.log,
      },
      { ...(mode === 'scripted' ? {} : { llm: new OllamaClient() }) },
    );
    transport.onEvents((events) => orchestrator.handle(events));
    orchestrator.resume();
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
    const items = this.inbox.consume(sessionId);
    if (items.length === 0) return undefined;
    return wrapPeerData({
      from: 'room',
      kind: 'coordination',
      text: items.map((item) => item.text).join('\n'),
    });
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

  /**
   * Resolve a read's symbols and publish it, off the hook's critical path.
   * Failures are logged, never thrown: there is no caller left to catch them.
   */
  private async publishObserved(event: NewEvent, cwd: string): Promise<void> {
    try {
      await this.submit(this.attachReadSymbols(event, cwd));
    } catch (error) {
      this.log.warn(
        { err: error instanceof Error ? error.message : String(error), type: event.payload.type },
        'could not publish an observed event',
      );
    }
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

function shellCommand(input: HookInput): string | undefined {
  const command = input.tool_input?.command ?? input.tool_input?.CommandLine;
  return typeof command === 'string' ? command : undefined;
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

/**
 * A short phrase for what a session is doing, from the event alone.
 *
 * This is what makes the room view live without the agent cooperating: hooks
 * report every read, write and tool call already, so an agent never has to be
 * told to announce itself. `announce_intent` is for stating the *goal* of a
 * piece of work; this covers the moment-to-moment.
 */
function describeActivity(payload: Event['payload']): string {
  switch (payload.type) {
    case 'FILE_READ':
      return `reading ${basename(payload.path)}`;
    case 'FILE_WRITE':
      return `editing ${basename(payload.path)}`;
    case 'TOOL_CALL': {
      if (payload.tool === 'HumanPrompt') return 'given a new prompt';
      // A file it touched beats naming the tool: "looking at checkout.ts" is
      // what a person wants to know, not which binary produced it.
      if (payload.paths?.length) {
        const [first, ...rest] = payload.paths.map((path) => basename(path));
        return `looking at ${first}${rest.length ? ` +${rest.length}` : ''}`;
      }
      return `running ${toolLabel(payload.tool)}`;
    }
    case 'INTENT':
      return `planning: ${payload.task}`;
    case 'LEASE_REQUESTED':
      return 'claiming symbols';
    case 'LEASE_DENIED':
      return 'blocked on a lease';
    case 'PROPOSAL':
      return 'proposing a contract';
    case 'COUNTER':
      return 'countering a contract';
    case 'ACCEPT':
      return 'accepting a contract';
    case 'MESSAGE':
      return 'messaging a peer';
    case 'SESSION_STARTED':
      return 'starting up';
    case 'COMPLETE_CLAIMED':
      return 'wrapping up';
    default:
      return payload.type.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * A tool name fit for a one-line status.
 *
 * The Claude adapter packs a redacted copy of the shell command into the tool
 * name (`Bash: cd /repo && sed -n 1,40p src/x.ts`), which is useful in a
 * transcript and unreadable in a room view. Keep the tool, drop the command,
 * and turn an MCP triple into just the tool it names.
 */
export function toolLabel(tool: string): string {
  const base = String(tool).split(':')[0]?.trim() ?? '';
  const mcp = base.match(/^mcp__[^_]+__(.+)$/);
  if (mcp?.[1]) return mcp[1].replace(/_/g, ' ');
  if (base === 'Bash' || base === 'shell') return 'a shell command';
  return base || 'a tool';
}
