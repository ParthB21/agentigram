import { createHash } from 'node:crypto';
import {
  type RoomState,
  type SymbolKey,
  SymbolKeySchema,
  symbolKey,
} from '@agentigram/protocol';

/**
 * Work allocation across the room (spec → "Leases, not locks", CLAUDE.md rule 4).
 *
 * Detection tells the room a conflict has *happened*. Allocation is the other half: decide up
 * front who owns which file, so the second agent is stopped at its PreToolUse hook rather than
 * discovered afterwards. Everything here is pure and deterministic — a model may reorder the
 * ownership map and write the prose, but it can never invent a file, a symbol key or an owner,
 * because `composePlan` recomputes both from what the room has actually observed.
 */

const MAX_FILES_PER_SESSION = 12;
const MAX_SYMBOLS_PER_FILE = 6;
const MAX_INTENT_SYMBOLS = 20;
const MAX_LEASED_SYMBOLS = 16;
const MAX_TASK_CHARS = 180;
/** Paths that say nothing about who owns what. */
const IGNORED = [/(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist\//, /\.lock$/];

export type SessionBrief = {
  sessionId: string;
  engineerId: string;
  host: string;
  model: string;
  /** Set only when the agent announced it itself. The plan never overwrites one. */
  declaredTask?: string;
  /** Files it declared it would change. The strongest claim after an actual write. */
  declaredFiles: string[];
  writeFiles: string[];
  readFiles: string[];
  symbols: SymbolKey[];
};

export type RoomBrief = {
  roomId: string;
  sessions: SessionBrief[];
  /** symbol key -> the session already holding a lease on it. */
  leased: Record<string, string>;
  /** Files at least two sessions are interested in. Sorted. */
  contested: string[];
};

export type Assignment = {
  sessionId: string;
  task: string;
  /** Files this session owns for now, contested ones first. */
  owns: string[];
  /** Known symbols inside the files it owns — what its announced intent covers. */
  symbols: SymbolKey[];
  /** Keys to lease, so everyone else is denied at the hook. Only ever for contested files. */
  claim: SymbolKey[];
  /** Files it has touched that someone else owns. */
  avoid: { path: string; owner: string }[];
};

export type Plan = {
  summary: string;
  assignments: Assignment[];
  /** Contested files and who lost them, for the room announcement. */
  handoffs: { path: string; owner: string; alsoWanted: string[] }[];
};

const norm = (value: string): string => value.replaceAll('\\', '/').replace(/^\.\//, '');
const usable = (path: string): boolean =>
  path.length > 0 && path !== '.' && path !== '..' && !IGNORED.some((rx) => rx.test(path));
const unique = (values: readonly string[]): string[] => [...new Set(values)];
export const basename = (path: string): string => path.split('/').pop() ?? path;

/** A whole-file claim, for a contested file the symbol index knows nothing about. */
export function moduleKey(path: string): SymbolKey | undefined {
  const name = basename(path).replace(/\.[^.]+$/, '').replaceAll('.', '-');
  const safe = name.replace(/[#:]/g, '');
  if (safe.length === 0) return undefined;
  try {
    return symbolKey(path, safe, 'module');
  } catch {
    return undefined;
  }
}

/** What the room has observed, reduced to the few facts an allocation needs. */
export function buildBrief(state: RoomState): RoomBrief {
  const sessions: SessionBrief[] = Object.values(state.sessions)
    .filter((session) => session.status !== 'ended')
    .map((session) => ({
      sessionId: session.sessionId,
      engineerId: session.engineerId,
      host: session.host,
      model: session.model,
      ...(session.intent?.task ? { declaredTask: session.intent.task } : {}),
      declaredFiles: (session.intent?.files ?? []).map(norm).filter(usable),
      writeFiles: (session.writeFiles ?? []).map(norm).filter(usable),
      readFiles: (session.readFiles ?? []).map(norm).filter(usable),
      symbols: unique([...(session.readSymbols ?? []), ...(session.intent?.symbols ?? [])]),
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const leased: Record<string, string> = {};
  for (const lease of Object.values(state.leases)) {
    for (const key of lease.symbols) leased[key] = lease.sessionId;
  }

  const interest = interestMap(sessions);
  const contested = [...interest]
    .filter(([, who]) => who.size >= 2)
    .map(([path]) => path)
    .sort();

  return { roomId: state.roomId, sessions, leased, contested };
}

/** Every session with any claim on a path, whether it read it, wrote it or declared it. */
function interestMap(sessions: readonly SessionBrief[]): Map<string, Set<string>> {
  const interest = new Map<string, Set<string>>();
  for (const session of sessions) {
    for (const path of [...session.writeFiles, ...session.declaredFiles, ...session.readFiles]) {
      const who = interest.get(path) ?? new Set<string>();
      who.add(session.sessionId);
      interest.set(path, who);
    }
  }
  return interest;
}

/**
 * One owner per file.
 *
 * A session that has already written the file beats one that only declared it, which beats one
 * that merely read it; ties break on `sessionId` so every laptop computes the same map. A
 * preference (from the model, or from a human) is honoured only for a session that is actually
 * interested in the file — otherwise the plan would hand work to an agent that has never seen it.
 */
export function assignOwners(
  brief: RoomBrief,
  preference: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [path, who] of interestMap(brief.sessions)) {
    const preferred = preference.get(path);
    if (preferred && who.has(preferred)) {
      owners.set(path, preferred);
      continue;
    }
    // An existing lease is the room's standing answer; never reassign under a live one.
    const holder = Object.entries(brief.leased).find(
      ([key, session]) => norm(key.split('#')[0] ?? '') === path && who.has(session),
    );
    if (holder?.[1]) {
      owners.set(path, holder[1]);
      continue;
    }
    for (const rank of ['writeFiles', 'declaredFiles', 'readFiles'] as const) {
      const claimant = brief.sessions.find(
        (session) => who.has(session.sessionId) && session[rank].includes(path),
      );
      if (claimant) {
        owners.set(path, claimant.sessionId);
        break;
      }
    }
  }
  return owners;
}

/** What a session is doing, when it has not said so itself. */
function inferTask(session: SessionBrief, owns: readonly string[]): string {
  if (session.declaredTask) return session.declaredTask.slice(0, MAX_TASK_CHARS);
  if (owns.length === 0) return 'No files touched yet; waiting for work.';
  const verb = session.writeFiles.length > 0 ? 'Changing' : 'Working through';
  const names = owns.slice(0, 3).map(basename);
  const rest = owns.length > names.length ? ` and ${owns.length - names.length} more` : '';
  return `${verb} ${names.join(', ')}${rest}.`.slice(0, MAX_TASK_CHARS);
}

/**
 * Turn an ownership map into the plan the room publishes: who owns what, what to lease, and what
 * each session must keep its hands off. Symbol keys come only from what the room observed, plus a
 * module key for a contested file the index could not resolve.
 */
export function composePlan(
  brief: RoomBrief,
  owners: ReadonlyMap<string, string>,
  tasks: ReadonlyMap<string, string> = new Map(),
): Plan {
  const contested = new Set(brief.contested);
  const interest = interestMap(brief.sessions);
  const observedSymbols = unique(brief.sessions.flatMap((session) => session.symbols));
  let leaseBudget = MAX_LEASED_SYMBOLS;

  const assignments: Assignment[] = brief.sessions.map((session) => {
    const owns = [...owners]
      .filter(([, owner]) => owner === session.sessionId)
      .map(([path]) => path)
      .sort((a, b) => Number(contested.has(b)) - Number(contested.has(a)) || a.localeCompare(b))
      .slice(0, MAX_FILES_PER_SESSION);

    const claim: SymbolKey[] = [];
    for (const path of owns.filter((candidate) => contested.has(candidate))) {
      if (leaseBudget <= 0) break;
      const forFile = observedSymbols
        .filter((key) => norm(key.split('#')[0] ?? '') === path)
        .sort()
        .slice(0, MAX_SYMBOLS_PER_FILE);
      const whole = moduleKey(path);
      const keys = forFile.length > 0 ? forFile : whole ? [whole] : [];
      for (const key of keys) {
        // Someone else's live lease stands; re-requesting it would only produce a denial.
        const holder = brief.leased[key];
        if (holder && holder !== session.sessionId) continue;
        if (!SymbolKeySchema.safeParse(key).success) continue;
        if (claim.includes(key)) continue;
        claim.push(key);
        leaseBudget -= 1;
      }
    }

    const touched = unique([...session.writeFiles, ...session.declaredFiles, ...session.readFiles]);
    const avoid = touched
      .filter((path) => (owners.get(path) ?? session.sessionId) !== session.sessionId)
      .map((path) => ({ path, owner: owners.get(path) as string }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const task = (tasks.get(session.sessionId) ?? '').trim().slice(0, MAX_TASK_CHARS);
    return {
      sessionId: session.sessionId,
      // A self-declared intent is the agent's own word on what it is doing; the plan never edits it.
      task: session.declaredTask ?? (task || inferTask(session, owns)),
      owns,
      symbols: observedSymbols
        .filter((key) => owns.includes(norm(key.split('#')[0] ?? '')))
        .sort()
        .slice(0, MAX_INTENT_SYMBOLS),
      claim,
      avoid,
    };
  });

  const handoffs = brief.contested
    .map((path) => ({
      path,
      owner: owners.get(path) ?? '',
      alsoWanted: [...(interest.get(path) ?? [])].filter((id) => id !== owners.get(path)).sort(),
    }))
    .filter((handoff) => handoff.owner.length > 0 && handoff.alsoWanted.length > 0);

  return { summary: summarise(brief, handoffs), assignments, handoffs };
}

/** The plan with no model involved: the fallback, and the shape a model's draft is repaired into. */
export function deterministicPlan(brief: RoomBrief): Plan {
  const owners = assignOwners(brief);
  const tasks = new Map(
    brief.sessions.map((session) => [
      session.sessionId,
      inferTask(
        session,
        [...owners].filter(([, owner]) => owner === session.sessionId).map(([path]) => path),
      ),
    ]),
  );
  return composePlan(brief, owners, tasks);
}

function summarise(brief: RoomBrief, handoffs: Plan['handoffs']): string {
  const agents = `${brief.sessions.length} agent${brief.sessions.length === 1 ? '' : 's'}`;
  if (handoffs.length === 0) {
    return `${agents} in the room, no shared files. Everyone keeps what they are working on.`;
  }
  const first = handoffs[0] as Plan['handoffs'][number];
  const rest = handoffs.length > 1 ? ` and ${handoffs.length - 1} more file(s)` : '';
  return `${agents} in the room. ${basename(first.path)} is wanted by ${
    first.alsoWanted.length + 1
  } of them${rest}; ${first.owner} keeps it and the others work around it.`;
}

/** Stable across identical plans, so an unchanged plan is never announced twice. */
export function planFingerprint(plan: Plan): string {
  const material = plan.assignments.map((assignment) => ({
    sessionId: assignment.sessionId,
    task: assignment.task,
    owns: assignment.owns,
    symbols: assignment.symbols,
    claim: assignment.claim,
    avoid: assignment.avoid,
  }));
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

/** The brief one agent is told, in plain sentences: what it owns and what it must not touch. */
export function assignmentBrief(assignment: Assignment, plan: Plan): string {
  const lines = [`Agentigram's orchestrator has allocated this room's work. ${plan.summary}`];
  lines.push(`Your task: ${assignment.task}`);
  if (assignment.owns.length > 0) {
    lines.push(`You own, and are the only one who may edit: ${assignment.owns.join(', ')}.`);
  }
  if (assignment.claim.length > 0) {
    lines.push(`Those files are leased to you, so no other agent can write them while you work.`);
  }
  for (const { path, owner } of assignment.avoid) {
    lines.push(`Do not edit ${path} — ${owner} owns it. Message ${owner} if you need it changed.`);
  }
  lines.push(
    'If you need something outside what you own, say so instead of editing it; the orchestrator will negotiate it.',
  );
  return lines.join('\n');
}
