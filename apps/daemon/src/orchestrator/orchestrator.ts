import { compile } from '@agentigram/contracts';
import {
  type CollisionState,
  type Event,
  MAX_AUTOMATION_DEPTH,
  type NewEvent,
  type RoomState,
  type SessionInfo,
} from '@agentigram/protocol';
import { MAX_NEGOTIATION_ROUNDS } from '@agentigram/reducer';
import {
  consensusTurn,
  type DebateContext,
  fallbackContract,
  proposeTurn,
  respondTurn,
  type Turn,
} from './debate.js';
import type { Llm } from './ollama.js';

/** The parts of a daemon the orchestrator needs; small so a debate can be tested with no sockets. */
export type OrchestratorHost = {
  roomId: string;
  engineerId: string;
  state(): RoomState;
  /** Submits as the authority: the orchestrator speaks for the room and for each side of a debate. */
  submit(event: NewEvent): Promise<number>;
  log: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
};

export type OrchestratorOptions = {
  llm?: Llm;
  /** How long agents get to negotiate for themselves before the orchestrator steps in. */
  graceMs?: number;
  /** Waits long enough for a line to be spoken aloud before the next one is published. */
  pace?: (text: string) => Promise<void>;
};

const DEFAULT_GRACE_MS = 4_000;
const SETTLED = new Set(['Accepted', 'Compiled', 'Verified', 'Escalated']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const speechPace = (text: string) => sleep(Math.min(9_000, 1_200 + 55 * text.length));

/**
 * The room's single decision maker for collisions. Runs on the authority only, so a collision is
 * debated once no matter how many laptops are connected.
 *
 * A collision freezes both agents' writes to the contested files (`freezeDenial`, enforced in the
 * PreToolUse hook). The orchestrator then runs the negotiation the protocol already models —
 * PROPOSAL, COUNTER, ACCEPT — voicing each side from its declared intent, so every turn is an
 * ordinary event that the room view, the reducer and TTS already handle. Agents that negotiate
 * for themselves during the grace window are joined, not overruled. When both sides have accepted
 * the contract is compiled, the freeze lifts (the negotiation is `Accepted`), and a resume message
 * goes out.
 *
 * Turns are stamped `source: 'system'`: they are the orchestrator speaking for an agent, not the
 * agent's own words.
 */
export class Orchestrator {
  private readonly seen = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private readonly llm: Llm | undefined;
  private readonly graceMs: number;
  private readonly pace: (text: string) => Promise<void>;

  constructor(
    private readonly host: OrchestratorHost,
    options: OrchestratorOptions = {},
  ) {
    this.llm = options.llm;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.pace = options.pace ?? speechPace;
  }

  /** Feed every event the authority publishes. */
  handle(events: readonly Event[]): void {
    for (const event of events) {
      if (event.payload.type === 'COLLISION' && event.payload.tier !== 'FILE_OVERLAP') {
        this.enqueue(event.payload.collisionId);
      }
    }
  }

  /** Pick up collisions left open by a previous run of the authority. */
  resume(): void {
    for (const collision of Object.values(this.host.state().collisions)) {
      if (collision.status === 'open' && collision.tier !== 'FILE_OVERLAP') {
        this.enqueue(collision.collisionId);
      }
    }
  }

  /** Resolves when every queued debate has finished. */
  idle(): Promise<void> {
    return this.tail;
  }

  private enqueue(collisionId: string): void {
    if (this.seen.has(collisionId)) return;
    this.seen.add(collisionId);
    // One debate at a time: two at once would talk over each other on every speaker.
    this.tail = this.tail
      .then(() => this.debate(collisionId))
      .catch((error) =>
        this.host.log.warn(
          { err: error instanceof Error ? error.message : String(error), collisionId },
          'orchestrator debate failed',
        ),
      );
  }

  private async debate(collisionId: string): Promise<void> {
    await sleep(this.graceMs);
    const state = this.host.state();
    const collision = state.collisions[collisionId];
    const negotiation = state.negotiations[collisionId];
    if (!collision || collision.status !== 'open') return;
    if (negotiation && SETTLED.has(negotiation.state)) return;
    const writer = state.sessions[collision.writerSession];
    const affected = state.sessions[collision.affectedSessions[0] ?? ''];
    // A contract names a symbol; a collision with none (a file-level overlap) has nothing to compile.
    if (!writer || !affected || collision.symbols.length === 0) return;

    const ctx: DebateContext = {
      collision,
      writer,
      affected,
      history: [],
      contract: negotiation?.contract ?? fallbackContract({ collision, writer, affected }),
    };
    let author = writer;
    if (negotiation?.contract && negotiation.state !== 'Open') {
      author = negotiation.state === 'Countered' ? affected : writer;
    } else {
      const opening = await proposeTurn(ctx, this.llm);
      await this.say(opening, writer, affected, collision);
      ctx.contract = opening.contract;
      ctx.history.push(opening);
    }

    // A counter beyond MAX_NEGOTIATION_ROUNDS would escalate to a human; stop one short and merge.
    let counters = 0;
    let agreed = false;
    while (counters < MAX_NEGOTIATION_ROUNDS - 1) {
      const responder = author === writer ? affected : writer;
      const turn = await respondTurn(ctx, responder, author, this.llm);
      ctx.history.push(turn);
      await this.say(turn, responder, author, collision);
      ctx.contract = turn.contract;
      if (turn.stance === 'accept') {
        await this.say(agreement(author, ctx), author, responder, collision);
        agreed = true;
        break;
      }
      counters += 1;
      author = responder;
    }
    if (!agreed) await this.synthesise(ctx, collision);
    await this.conclude(ctx, collision);
  }

  /** Both sides ran out of rounds: the orchestrator merges the debate, and both accept the result. */
  private async synthesise(ctx: DebateContext, collision: CollisionState): Promise<void> {
    const merged = await consensusTurn(ctx, this.llm);
    ctx.contract = merged.contract;
    await this.emit('system', {
      type: 'MESSAGE',
      to: 'all',
      text: merged.message,
      ...tag(collision),
    });
    await this.pace(merged.message);
    await this.emit('system', {
      type: 'PROPOSAL',
      collisionId: collision.collisionId,
      contract: merged.contract,
    });
    await this.say(agreement(ctx.writer, ctx), ctx.writer, ctx.affected, collision);
    await this.say(agreement(ctx.affected, ctx), ctx.affected, ctx.writer, collision);
  }

  private async conclude(ctx: DebateContext, collision: CollisionState): Promise<void> {
    const negotiation = this.host.state().negotiations[collision.collisionId];
    if (negotiation?.state !== 'Accepted') {
      this.host.log.warn(
        { collisionId: collision.collisionId, state: negotiation?.state },
        'debate ended without acceptance',
      );
      await this.emit('system', {
        type: 'ESCALATE',
        collisionId: collision.collisionId,
        reason: 'The agents could not agree on a contract; a human needs to decide.',
      });
      return;
    }
    const compiled = compile(ctx.contract);
    await this.emit('system', {
      type: 'CONTRACT_COMPILED',
      contractId: compiled.contractId,
      collisionId: collision.collisionId,
      checkFiles: compiled.checkFiles,
    });
    const { contract } = ctx;
    const report = [
      `Resolved: ${contract.symbol} changes from ${contract.before} to ${contract.after}.`,
      contract.constraint ? `Constraint: ${contract.constraint}` : '',
      contract.migration ? `Migration: ${contract.migration}` : '',
      `${ctx.writer.sessionId} and ${ctx.affected.sessionId} may resume; the contract check is ${compiled.contractId}.`,
    ]
      .filter(Boolean)
      .join(' ');
    // Depth 0 so a managed runner wakes and resumes its agent; the debate turns above cannot.
    await this.emit('system', {
      type: 'MESSAGE',
      to: 'all',
      text: report.slice(0, 1_900),
      ...tag(collision),
      automationDepth: 0,
    });
  }

  /** Publish one turn as its structured event plus, where the event has no text of its own, a spoken line. */
  private async say(
    turn: Turn,
    speaker: SessionInfo,
    other: SessionInfo,
    collision: CollisionState,
  ): Promise<void> {
    const { collisionId } = collision;
    if (turn.stance === 'counter') {
      // COUNTER's `reason` is the line TTS speaks, so no separate MESSAGE.
      await this.emit(speaker, {
        type: 'COUNTER',
        collisionId,
        contract: turn.contract,
        reason: turn.message,
      });
    } else {
      await this.emit(speaker, {
        type: 'MESSAGE',
        to: other.sessionId,
        text: turn.message,
        ...tag(collision),
        automationDepth: MAX_AUTOMATION_DEPTH,
      });
      await this.emit(
        speaker,
        turn.stance === 'propose'
          ? { type: 'PROPOSAL', collisionId, contract: turn.contract }
          : { type: 'ACCEPT', collisionId },
      );
    }
    await this.pace(turn.message);
  }

  private emit(who: SessionInfo | 'system', payload: NewEvent['payload']): Promise<number> {
    return this.host.submit({
      id: crypto.randomUUID(),
      roomId: this.host.roomId,
      actor:
        who === 'system'
          ? { engineerId: this.host.engineerId, kind: 'system' }
          : { engineerId: who.engineerId, sessionId: who.sessionId, kind: 'agent' },
      source: 'system',
      payload,
    });
  }
}

const tag = (collision: CollisionState) => ({
  collisionId: collision.collisionId,
  conversationId: `orchestrator:${collision.collisionId}`.slice(0, 128),
});

function agreement(session: SessionInfo, ctx: DebateContext): Turn {
  return {
    speaker: session.sessionId,
    stance: 'accept',
    message: `Agreed. I will build to the contract for ${ctx.contract.symbol}.`,
    contract: ctx.contract,
  };
}
