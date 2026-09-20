import { createHash } from 'node:crypto';
import { fileOverlap } from '@agentigram/analysis';
import type { CollisionTier, Event, RoomState, SymbolKey } from '@agentigram/protocol';

/**
 * Tier 0/1 collision detection (spec → "Detection tiers"). Deterministic: no LLM, no I/O.
 *
 * Tier 1 (`PREDICTED`) is a symbol hit — the writer is touching a symbol another session has
 * already read. Tier 0 (`FILE_OVERLAP`) is the weaker path-level fallback. A symbol hit wins,
 * because "you are changing `User.id`, which Payments read" is worth interrupting an agent for
 * and "you are both in user.ts" usually is not.
 */
export type CollisionCandidate = {
  collisionId: string;
  tier: CollisionTier;
  symbols: SymbolKey[];
  writerSession: string;
  affectedSessions: string[];
  detail: string;
  confidence: number;
};

const CONFIDENCE: Record<string, number> = { PREDICTED: 0.8, FILE_OVERLAP: 0.4 };

/**
 * What the writer is touching, per event type. Anything else is not a write intent.
 *
 * `FILE_WRITE` carries no symbols — a hook sees a path, not an AST. The symbols for a write come
 * from what that session already announced it was going to change, narrowed to the file it just
 * touched, which is what makes a write land as tier 1 rather than tier 0.
 */
function touched(
  state: RoomState,
  event: Event,
  writer: string,
): { files: string[]; symbols: SymbolKey[] } | undefined {
  const payload = event.payload;
  if (payload.type === 'INTENT') return { files: payload.files, symbols: payload.symbols };
  if (payload.type !== 'FILE_WRITE') return undefined;
  const declared = state.sessions[writer]?.intent?.symbols ?? [];
  const prefix = `${norm(payload.path)}#`;
  return { files: [payload.path], symbols: declared.filter((key) => norm(key).startsWith(prefix)) };
}

const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const right = new Set(b);
  return [...new Set(a)].filter((value) => right.has(value)).sort();
}

/**
 * Stable across repeats so an open collision is not re-opened on every keystroke: the same writer
 * touching the same keys against the same peer always hashes to the same id.
 */
function collisionId(roomId: string, writer: string, affected: string, keys: string[]): string {
  return createHash('sha256')
    .update([roomId, writer, affected, ...[...keys].sort()].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/** `src/types/user.ts#User.id:property` -> `User.id`. Paths pass through unchanged. */
function readable(hit: string): string {
  const hash = hit.indexOf('#');
  if (hash < 0) return hit;
  const rest = hit.slice(hash + 1);
  const colon = rest.lastIndexOf(':');
  return colon < 0 ? rest : rest.slice(0, colon);
}

function describe(
  tier: CollisionTier,
  writer: string,
  affected: string,
  hits: string[],
  task: string | undefined,
): string {
  // `detail` is read by a human in the room view and handed to the on-device
  // model as the description of the conflict, so it names `User.id` rather
  // than the full symbol key. The keys themselves travel in `symbols`.
  const head = hits.slice(0, 3).map(readable).join(', ');
  const rest = hits.length > 3 ? ` (+${hits.length - 3} more)` : '';
  const because = task ? ` while working on "${task}"` : '';
  return tier === 'PREDICTED'
    ? `${writer} is changing ${head}${rest}${because}; ${affected} has already read ${hits.length === 1 ? 'it' : 'them'}.`
    : `${writer} is writing ${head}${rest}${because}; ${affected} has the same ${hits.length === 1 ? 'file' : 'files'} open.`;
}

/**
 * Compare one event against every other live session. Returns one candidate per affected session,
 * which keeps each negotiation a two-party conversation.
 *
 * Callers must only act on this at the authority, so a collision is opened once by the single
 * writer rather than once per laptop.
 */
export function detectCollisions(state: RoomState, event: Event): CollisionCandidate[] {
  const writer = event.actor.sessionId;
  if (!writer) return [];
  const write = touched(state, event, writer);
  if (!write) return [];

  const candidates: CollisionCandidate[] = [];
  for (const session of Object.values(state.sessions)) {
    if (session.sessionId === writer || session.status === 'ended') continue;

    // Symbols the other session cares about: ones it has read, and ones it has
    // announced it intends to change. The second half is what makes this work
    // for a host whose hooks are not firing — an agent that can only reach the
    // MCP tools still declares an intent, and that is enough to be collided
    // with. The reducer covers no symbol case at all, so there is nothing to
    // double up with here.
    const theirSymbols = [...(session.readSymbols ?? []), ...(session.intent?.symbols ?? [])];
    const symbolHits = intersect(write.symbols, theirSymbols);
    // Reads only. Write-vs-write on the same path is already opened by the
    // reducer (`applyFileWrite`), and counting it here would open a second
    // collision for one overlap. The gap this fills is the asymmetric case the
    // reducer cannot see: one session writing what another has merely read.
    // A declared intent has no FILE_WRITE for the reducer to open a write-vs-write collision from,
    // so an INTENT is also compared against the files the peer writes or has claimed. That is what
    // gives two agents who both claimed a file — and were both stopped for it — a collision to release.
    const theirFiles =
      event.payload.type === 'INTENT'
        ? [
            ...(session.readFiles ?? []),
            ...(session.writeFiles ?? []),
            ...(session.intent?.files ?? []),
          ]
        : (session.readFiles ?? []);
    const fileHits = fileOverlap(write.files, theirFiles);
    const tier: CollisionTier | undefined =
      symbolHits.length > 0 ? 'PREDICTED' : fileHits.length > 0 ? 'FILE_OVERLAP' : undefined;
    if (!tier) continue;

    const hits = tier === 'PREDICTED' ? symbolHits : fileHits;
    const id = collisionId(state.roomId, writer, session.sessionId, hits);
    // Already being negotiated — re-announcing it would spam both agents' inboxes.
    if (state.collisions[id]?.status === 'open') continue;

    candidates.push({
      collisionId: id,
      tier,
      symbols: tier === 'PREDICTED' ? (hits as SymbolKey[]) : [],
      writerSession: writer,
      affectedSessions: [session.sessionId],
      detail: describe(tier, writer, session.sessionId, hits, state.sessions[writer]?.intent?.task),
      confidence: CONFIDENCE[tier] ?? 0.5,
    });
  }
  return candidates;
}
