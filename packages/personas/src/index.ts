import type { Event } from '@clankergram/protocol';

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
export type RenderOptions = { notableRenderer?: PersonaBatchRenderer };

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
  const ordered = [...eventsWindow].sort((left, right) => left.seq - right.seq);
  const cards = personaCards.length > 0 ? personaCards : DEFAULT_PERSONAS;
  const notable = ordered.filter((event) => NOTABLE_TYPES.has(event.payload.type));
  const ordinary = ordered.filter((event) => !NOTABLE_TYPES.has(event.payload.type));
  const templateLines = ordinary.map((event) => templateLine(event, cards));
  if (!options.notableRenderer || notable.length === 0) {
    return [...templateLines, ...notable.map((event) => templateLine(event, cards))]
      .sort((left, right) => left.seq - right.seq)
      .map(safetyPass);
  }
  const generated = await options.notableRenderer(notable, cards);
  const validSequences = new Set(notable.map((event) => event.seq));
  const safeGenerated = generated.filter((line) => validSequences.has(line.seq)).map(safetyPass);
  return [...templateLines, ...safeGenerated].sort((left, right) => left.seq - right.seq);
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
