import type { Event } from '@agentigram/protocol';

const MAX_LINE_LENGTH = 220;
const NOTABLE_TYPES = new Set([
  'COLLISION',
  'SPEC_MERGE_RESULT',
  'ESCALATE',
  'RUN_VERIFIED',
  'DUEL_RESULT',
]);

export type PersonaCard = {
  role: string;
  tone: string;
  verbosity: 'terse' | 'normal' | 'chatty';
  catchphrases: string[];
};
export type PersonaLine = { speaker: string; text: string; seq: number };
export type PersonaBatchRenderer = (
  events: Event[],
  cards: PersonaCard[],
) => Promise<PersonaLine[]>;
export type RenderOptions = {
  notableRenderer?: PersonaBatchRenderer;
  /** Already-rendered event sequences, used by the worker's replay-safe dedupe cache. */
  seenSequences?: ReadonlySet<number>;
  maxLines?: number;
};

export type PrioritizedPersonaLine = PersonaLine & {
  priority: 0 | 1 | 2 | 3;
  replyTo?: string;
};

export const DEFAULT_PERSONAS: PersonaCard[] = [
  {
    role: 'Backend',
    tone: 'precise and dry',
    verbosity: 'terse',
    catchphrases: ['The type is the contract.'],
  },
  {
    role: 'Payments',
    tone: 'risk-aware and pragmatic',
    verbosity: 'normal',
    catchphrases: ['Holding the write.'],
  },
  {
    role: 'Frontend',
    tone: 'clear and user-focused',
    verbosity: 'normal',
    catchphrases: ['The edge case is the interface.'],
  },
  {
    role: 'Security',
    tone: 'calm and skeptical',
    verbosity: 'terse',
    catchphrases: ['Trust, then verify.'],
  },
];

export async function render(
  eventsWindow: Event[],
  personaCards: PersonaCard[],
  options: RenderOptions = {},
): Promise<PersonaLine[]> {
  const seen = options.seenSequences ?? new Set<number>();
  const ordered = [...new Map(eventsWindow.map((event) => [event.seq, event])).values()]
    .filter((event) => !seen.has(event.seq))
    .sort((left, right) => left.seq - right.seq);
  const cards = personaCards.length > 0 ? personaCards : DEFAULT_PERSONAS;
  const notable = ordered.filter((event) => NOTABLE_TYPES.has(event.payload.type));
  const ordinary = ordered.filter((event) => !NOTABLE_TYPES.has(event.payload.type));
  const templateLines = ordinary.map((event) => templateLine(event, cards));
  if (!options.notableRenderer || notable.length === 0) {
    return [...templateLines, ...notable.map((event) => templateLine(event, cards))]
      .sort((left, right) => left.seq - right.seq)
      .map(safetyPass);
  }
  let generated: PersonaLine[] = [];
  try {
    generated = await options.notableRenderer(notable, cards);
  } catch {
    generated = [];
  }
  const validSequences = new Set(notable.map((event) => event.seq));
  const safeGenerated = generated
    .filter((line) => validSequences.has(line.seq))
    .filter(
      (line, index, all) => all.findIndex((candidate) => candidate.seq === line.seq) === index,
    )
    .map(safetyPass);
  const generatedSequences = new Set(safeGenerated.map((line) => line.seq));
  const fallbacks = notable
    .filter((event) => !generatedSequences.has(event.seq))
    .map((event) => safetyPass(templateLine(event, cards)));
  return [...templateLines, ...safeGenerated, ...fallbacks]
    .sort((left, right) => left.seq - right.seq)
    .slice(0, options.maxLines ?? Number.POSITIVE_INFINITY);
}

/** Adds delivery metadata for the single global speech queue without changing persisted lines. */
export function prioritize(lines: PersonaLine[], events: Event[]): PrioritizedPersonaLine[] {
  const bySequence = new Map(events.map((event) => [event.seq, event]));
  return lines.map((personaLine) => {
    const event = bySequence.get(personaLine.seq);
    const payload = event?.payload;
    const type = payload?.type;
    const priority: PrioritizedPersonaLine['priority'] =
      type === 'ESCALATE' || (payload?.type === 'COLLISION' && payload.tier === 'CONFIRMED')
        ? 3
        : type === 'SPEC_MERGE_RESULT' || type === 'BLOCKER' || type === 'LEASE_DENIED'
          ? 2
          : type === 'COLLISION' || type === 'MESSAGE'
            ? 1
            : 0;
    const replyTo = payload?.type === 'MESSAGE' ? payload.to : undefined;
    return { ...personaLine, priority, ...(replyTo ? { replyTo } : {}) };
  });
}

/** Deterministically groups an ordered event stream into renderer-sized conversation windows. */
export function conversationWindows(events: Event[], windowMs = 2_500): Event[][] {
  if (!(windowMs > 0)) throw new Error('windowMs must be positive');
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const windows: Event[][] = [];
  for (const event of ordered) {
    const current = windows.at(-1);
    const first = current?.[0];
    const elapsed = first ? Date.parse(event.ts) - Date.parse(first.ts) : 0;
    if (!current || !Number.isFinite(elapsed) || elapsed >= windowMs) windows.push([event]);
    else current.push(event);
  }
  return windows;
}

/** Prevent repeated low-priority lines while never suppressing urgent alerts. */
export function applyCooldown(
  lines: PrioritizedPersonaLine[],
  cooldownSequences = 3,
): PrioritizedPersonaLine[] {
  const lastBySpeaker = new Map<string, number>();
  return lines.filter((personaLine) => {
    const previous = lastBySpeaker.get(personaLine.speaker);
    if (
      personaLine.priority < 2 &&
      previous !== undefined &&
      personaLine.seq - previous < cooldownSequences
    )
      return false;
    lastBySpeaker.set(personaLine.speaker, personaLine.seq);
    return true;
  });
}

function templateLine(event: Event, cards: PersonaCard[]): PersonaLine {
  const role = roleFor(event, cards);
  const payload = event.payload;
  switch (payload.type) {
    case 'INTENT':
      return line(
        role,
        `Taking ${payload.task}. I’ll call out interface changes before I write.`,
        event.seq,
      );
    case 'FILE_WRITE':
      return line(role, `Updated ${payload.path}.`, event.seq);
    case 'API_DELTA': {
      const breaking = payload.changes.filter((change) => change.breaking).length;
      return line(
        role,
        breaking > 0
          ? `${breaking} breaking API change${breaking === 1 ? '' : 's'} detected.`
          : `The exported surface changed without a break.`,
        event.seq,
      );
    }
    case 'COLLISION':
      return line(
        role,
        `${payload.tier.toLowerCase().replace('_', ' ')} collision on ${shortSymbol(payload.symbols[0])}. ${payload.detail}`,
        event.seq,
      );
    case 'MESSAGE':
      return line(role, payload.text, event.seq);
    case 'PROPOSAL':
      return line(
        role,
        `Proposed ${shortSymbol(payload.contract.symbol)}: ${payload.contract.before} → ${payload.contract.after}.`,
        event.seq,
      );
    case 'COUNTER':
      return line(role, `Countered the contract: ${payload.reason}`, event.seq);
    case 'ACCEPT':
      return line(role, 'Accepted the contract. The check can be compiled.', event.seq);
    case 'CONTRACT_COMPILED':
      return line(
        role,
        `Contract compiled into ${payload.checkFiles.length} check file${payload.checkFiles.length === 1 ? '' : 's'}.`,
        event.seq,
      );
    case 'LEASE_DENIED':
      return line(
        role,
        `Holding the write. ${payload.heldBy} owns the active lease: ${payload.reason}`,
        event.seq,
      );
    case 'SPEC_MERGE_RESULT':
      return line(
        role,
        payload.typeErrors.length === 0 && payload.failingTests.length === 0
          ? 'The speculative merge is clean.'
          : `Speculative merge found ${payload.typeErrors.length} type errors and ${payload.failingTests.length} failing tests.`,
        event.seq,
      );
    case 'RUN_VERIFIED':
      return line(role, 'Verified. The work and its contract agree.', event.seq);
    case 'BLOCKER':
      return line(role, `Blocked: ${payload.text}`, event.seq);
    case 'DUEL_RESULT':
      return line(
        role,
        payload.winnerSession
          ? `${payload.winnerSession} won the duel: ${payload.reason}`
          : `The duel ended in a draw: ${payload.reason}`,
        event.seq,
      );
    case 'ESCALATE':
      return line(role, `Human decision needed: ${payload.reason}`, event.seq);
    default:
      return line(role, describeType(payload.type), event.seq);
  }
}

function roleFor(event: Event, cards: PersonaCard[]): string {
  const actor = event.actor.sessionId ?? event.actor.engineerId;
  const match = cards.find((card) => actor.toLowerCase().includes(card.role.toLowerCase()));
  return match?.role ?? actor;
}

function safetyPass(personaLine: PersonaLine): PersonaLine {
  const withoutPersonalAttacks = personaLine.text
    .replace(/\b(idiot|stupid|incompetent|lazy)\b/gi, 'incorrect')
    .replace(/\b(you are|you're)\s+(?:bad|awful|terrible)\b/gi, 'the code is incorrect')
    .replace(/\s+/g, ' ')
    .trim();
  return { ...personaLine, text: withoutPersonalAttacks.slice(0, MAX_LINE_LENGTH) };
}

function line(speaker: string, text: string, seq: number): PersonaLine {
  return { speaker, text, seq };
}

function shortSymbol(symbol: string | undefined): string {
  return symbol?.split('#').at(-1)?.split(':')[0] ?? 'the affected interface';
}

function describeType(type: string): string {
  return type.toLowerCase().replaceAll('_', ' ');
}
