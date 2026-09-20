import { redactSecrets } from '@agentigram/adapters';
import type { Event } from '@agentigram/protocol';
import { categorizeTask, difficultyFor, type TaskCategory } from '@agentigram/stats';
import type {
  AgentSummary,
  ConflictAction,
  ConflictRecord,
  ConflictResolution,
  Outcome,
  TimelineEntry,
} from './types.js';

const TEXT_CAP = 160;

type Acc = AgentSummary & {
  written: Set<string>;
  intentTask?: string;
  blockedAt?: number;
  lastSignal: Outcome;
};

export type Derived = {
  agents: AgentSummary[];
  conflicts: ConflictRecord[];
  timeline: TimelineEntry[];
  duels: { winner: string; loser: string }[];
};

const clip = (text: string, max = TEXT_CAP): string => {
  const clean = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** Category from the task text, falling back to what the agent actually touched when it never said. */
function categoryFor(text: string, paths: string[]): TaskCategory {
  if (text.trim()) return categorizeTask(text);
  const joined = paths.join('\n').toLowerCase();
  if (/\.(test|spec)\.|__tests__/.test(joined)) return 'TESTING';
  if (/\.md\b|docs\//.test(joined)) return 'DOCUMENTATION';
  if (/\.(css|scss|tsx|jsx)\b/.test(joined)) return 'FRONTEND';
  if (/migrations?\/|\.sql\b|schema/.test(joined)) return 'DATABASE';
  if (/\.github\/|dockerfile|\.ya?ml\b/.test(joined)) return 'DEVOPS';
  return 'FEATURE';
}

const resolutionOf = (conflict: ConflictRecord): ConflictResolution => {
  if (conflict.contractResult === 'pass') return 'verified';
  if (conflict.contractResult === 'fail') return 'failed';
  let state: ConflictResolution = 'open';
  for (const action of conflict.actions) {
    if (action.kind === 'ACCEPT') state = 'accepted';
    else if (action.kind === 'ESCALATE') state = 'escalated';
  }
  return state;
};

/** Reduce the authoritative event log to per-agent facts, conflict lifecycles and a journal. Pure. */
export function deriveFacts(events: Event[]): Derived {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const sessions = new Map<string, Acc>();
  const conflicts = new Map<string, ConflictRecord>();
  const contractToCollision = new Map<string, string>();
  const duelPairs = new Map<string, [string, string]>();
  const duels: Derived['duels'] = [];
  const timeline: TimelineEntry[] = [];
  const seenWrite = new Set<string>();

  const get = (sessionId: string, engineerId = 'unknown'): Acc => {
    let acc = sessions.get(sessionId);
    if (!acc) {
      acc = {
        sessionId,
        engineerId,
        host: 'unknown',
        model: 'unknown',
        category: 'FEATURE',
        difficulty: 'MEDIUM',
        filesRead: 0,
        filesWritten: [],
        toolCalls: 0,
        intents: 0,
        collisionsCaused: 0,
        collisionsAffected: 0,
        leaseDenials: 0,
        leaseBlockedMs: 0,
        proposals: 0,
        counters: 0,
        accepts: 0,
        escalations: 0,
        ci: { pass: 0, fail: 0 },
        contracts: { pass: 0, fail: 0 },
        runVerified: false,
        humanInterventions: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        outcome: 'unverified',
        written: new Set(),
        lastSignal: 'unverified',
      };
      sessions.set(sessionId, acc);
    }
    if (acc.engineerId === 'unknown') acc.engineerId = engineerId;
    return acc;
  };

  for (const event of ordered) {
    const p = event.payload;
    const sid = event.actor.sessionId;
    const at = Date.parse(event.ts);
    const actor = sid ? get(sid, event.actor.engineerId) : undefined;
    const note = (kind: string, text: string, session = sid) =>
      timeline.push({ seq: event.seq, ts: event.ts, ...(session ? { session } : {}), kind, text });
    const act = (id: string, kind: ConflictAction['kind'], text?: string) => {
      conflicts.get(id)?.actions.push({
        seq: event.seq,
        at: event.ts,
        ...(sid ? { by: sid } : {}),
        kind,
        ...(text ? { note: clip(text) } : {}),
      });
    };
    if (event.actor.kind === 'human' && actor) actor.humanInterventions += 1;

    switch (p.type) {
      case 'SESSION_STARTED': {
        const acc = get(p.sessionId, event.actor.engineerId);
        const first = acc.startedAt === undefined;
        acc.host = p.host;
        // The daemon announces before the host's hook knows the model; never let
        // that placeholder overwrite a real one.
        if (p.model !== 'unknown' || acc.model === 'unknown') acc.model = p.model;
        if (p.task) acc.task = p.task;
        acc.startedAt ??= event.ts;
        acc.endedAt = undefined;
        if (first) note('session', `joined on ${p.host} as ${p.model}`, p.sessionId);
        else if (p.model !== 'unknown') note('session', `identified as ${p.model}`, p.sessionId);
        break;
      }
      case 'SESSION_ENDED': {
        const acc = get(p.sessionId, event.actor.engineerId);
        acc.endedAt = event.ts;
        acc.endReason = p.reason;
        note('session', `left${p.reason ? ` (${p.reason})` : ''}`, p.sessionId);
        break;
      }
      case 'INTENT':
        if (actor) {
          actor.intents += 1;
          actor.intentTask ??= p.task;
        }
        note('intent', `intends: ${clip(p.task)} [${p.files.length} file(s)]`);
        break;
      case 'FILE_READ':
        if (actor) actor.filesRead += 1;
        break;
      case 'TOOL_CALL':
        if (actor && p.phase !== 'post') actor.toolCalls += 1;
        break;
      case 'FILE_WRITE':
        if (actor) {
          actor.written.add(p.path);
          if (!seenWrite.has(`${sid}\0${p.path}`)) {
            seenWrite.add(`${sid}\0${p.path}`);
            note('write', `first write to ${p.path}`);
          }
        }
        break;
      case 'USAGE':
        if (actor) {
          actor.inputTokens += p.inputTokens ?? 0;
          actor.outputTokens += p.outputTokens ?? 0;
          actor.costUsd += p.costUsd ?? 0;
          if (actor.model === 'unknown') actor.model = p.model;
        }
        break;
      case 'COLLISION': {
        conflicts.set(p.collisionId, {
          collisionId: p.collisionId,
          tier: p.tier,
          symbols: p.symbols,
          writer: p.writerSession,
          affected: p.affectedSessions,
          openedSeq: event.seq,
          openedAt: event.ts,
          detail: clip(p.detail),
          actions: [],
          resolution: 'open',
        });
        get(p.writerSession).collisionsCaused += 1;
        for (const other of p.affectedSessions) get(other).collisionsAffected += 1;
        note(
          'conflict',
          `${p.tier} collision on ${p.symbols.slice(0, 3).join(', ')}${p.symbols.length > 3 ? ` +${p.symbols.length - 3}` : ''}; ${p.writerSession} vs ${p.affectedSessions.join(', ') || 'nobody yet'}`,
          p.writerSession,
        );
        break;
      }
      case 'LEASE_DENIED':
        if (actor) {
          actor.leaseDenials += 1;
          if (Number.isFinite(at)) actor.blockedAt ??= at;
        }
        note('lease', `denied ${p.symbols.length} symbol(s); held by ${p.heldBy}`);
        break;
      case 'LEASE_GRANTED':
      case 'LEASE_RELEASED':
        if (actor?.blockedAt !== undefined && Number.isFinite(at)) {
          actor.leaseBlockedMs += Math.max(0, at - actor.blockedAt);
          actor.blockedAt = undefined;
        }
        break;
      case 'PROPOSAL':
        if (actor) actor.proposals += 1;
        act(
          p.collisionId,
          'PROPOSAL',
          `${p.contract.symbol}: ${p.contract.before} → ${p.contract.after}`,
        );
        note('negotiation', `proposed a contract on ${p.contract.symbol}`);
        break;
      case 'COUNTER':
        if (actor) actor.counters += 1;
        act(p.collisionId, 'COUNTER', p.reason);
        note('negotiation', `countered: ${clip(p.reason)}`);
        break;
      case 'ACCEPT':
        if (actor) actor.accepts += 1;
        act(p.collisionId, 'ACCEPT');
        note('negotiation', `accepted the contract for ${p.collisionId.slice(0, 8)}`);
        break;
      case 'ESCALATE':
        if (actor) actor.escalations += 1;
        act(p.collisionId, 'ESCALATE', p.reason);
        note('negotiation', `escalated to a human: ${clip(p.reason)}`);
        break;
      case 'MESSAGE':
        // Only negotiation chatter is worth keeping. The rest is mostly the orchestrator's
        // repeated allocation broadcast, which buried everything else in the timeline.
        if (p.collisionId) {
          act(p.collisionId, 'MESSAGE', p.text);
          note('message', `→ ${p.to}: ${clip(p.text)}`);
        }
        break;
      case 'CONTRACT_COMPILED':
        if (p.collisionId) contractToCollision.set(p.contractId, p.collisionId);
        if (p.collisionId) {
          const c = conflicts.get(p.collisionId);
          if (c) c.contractId = p.contractId;
        }
        note('contract', `compiled ${p.checkFiles.length} check file(s)`);
        break;
      case 'CONTRACT_RESULT': {
        const collisionId = contractToCollision.get(p.contractId);
        const conflict = collisionId ? conflicts.get(collisionId) : undefined;
        if (conflict) {
          conflict.contractResult = p.status;
          conflict.resolvedAt = event.ts;
        }
        // Credit the session that owned the change, or failing that whoever reported it.
        const owner = conflict ? get(conflict.writer) : actor;
        if (owner) {
          owner.contracts[p.status] += 1;
          owner.lastSignal = p.status;
        }
        note(
          'contract',
          `contract ${p.status}${p.detail ? `: ${clip(p.detail)}` : ''}`,
          owner?.sessionId,
        );
        break;
      }
      case 'CI_RESULT':
        if (p.sessionId) {
          const acc = get(p.sessionId);
          acc.ci[p.status] += 1;
          acc.lastSignal = p.status;
          note('ci', `CI ${p.status} on ${p.commit.slice(0, 7)}`, p.sessionId);
        }
        break;
      case 'RUN_VERIFIED': {
        const acc = get(p.sessionId);
        acc.runVerified = true;
        acc.lastSignal = 'pass';
        note('verify', 'run verified', p.sessionId);
        break;
      }
      case 'COMPLETE_CLAIMED':
        note('complete', `claims done: ${clip(p.summary)}`);
        break;
      case 'BLOCKER':
        note('blocker', clip(p.text));
        break;
      case 'BUG':
        note('bug', clip(p.text));
        break;
      case 'DISCOVERY':
        note('discovery', clip(p.text));
        break;
      case 'DUEL_STARTED':
        duelPairs.set(p.duelId, p.sessions);
        break;
      case 'DUEL_RESULT': {
        const pair = duelPairs.get(p.duelId);
        if (pair && p.winnerSession && pair.includes(p.winnerSession)) {
          const loser = pair[0] === p.winnerSession ? pair[1] : pair[0];
          duels.push({ winner: p.winnerSession, loser });
        }
        note(
          'duel',
          p.winnerSession
            ? `duel won by ${p.winnerSession}: ${clip(p.reason)}`
            : `duel drawn: ${clip(p.reason)}`,
        );
        break;
      }
      default:
        break;
    }
  }

  for (const conflict of conflicts.values()) {
    conflict.resolution = resolutionOf(conflict);
    const end = Date.parse(
      conflict.resolvedAt ??
        [...conflict.actions].reverse().find((a) => a.kind === 'ACCEPT' || a.kind === 'ESCALATE')
          ?.at ??
        '',
    );
    if (conflict.resolution !== 'open' && Number.isFinite(end)) {
      conflict.resolvedAt ??= new Date(end).toISOString();
      conflict.timeToResolutionMs = Math.max(0, end - Date.parse(conflict.openedAt));
    }
  }

  const agents = [...sessions.values()].map(
    ({ written, intentTask, blockedAt: _b, lastSignal, ...agent }): AgentSummary => {
      const text = agent.task ?? intentTask ?? '';
      const start = agent.startedAt ? Date.parse(agent.startedAt) : Number.NaN;
      const end = agent.endedAt ? Date.parse(agent.endedAt) : Number.NaN;
      return {
        ...agent,
        ...(text ? { task: text } : {}),
        filesWritten: [...written].sort(),
        category: categoryFor(text, [...written]),
        difficulty: difficultyFor(text),
        ...(Number.isFinite(start) && Number.isFinite(end)
          ? { activeMs: Math.max(0, end - start) }
          : {}),
        outcome: lastSignal,
      };
    },
  );
  return {
    agents: agents.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    conflicts: [...conflicts.values()],
    timeline,
    duels,
  };
}
