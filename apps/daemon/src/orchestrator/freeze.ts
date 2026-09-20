import type { CollisionState, RoomState } from '@agentigram/protocol';

/** Negotiation states in which the agents have agreed, so the freeze lifts. */
const SETTLED = new Set(['Accepted', 'Compiled', 'Verified']);

const norm = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * Loud on purpose. A polite "wait for the contract" reads to a model as a hurdle to route around
 * (a different tool, a shell redirect, a retry); this reads as a stop order it should hand back to
 * its human.
 */
const stopOrder = (path: string, why: string) =>
  `STOP. Do not modify ${path} — not with Edit or Write, not through the shell, not by any other route. ${why} Agentigram has frozen this file for every agent involved. Do not retry. Tell the user what you were about to change and that a human can release it with \`agg unfreeze --all\`. Then wait.`;

const involves = (collision: CollisionState, sessionId: string) =>
  collision.writerSession === sessionId || collision.affectedSessions.includes(sessionId);

/**
 * Whether a collision is about `target`. A tier-0 collision carries no symbols, so its file is only
 * recorded in `detail` (both the reducer's and `collide.ts` name the path there).
 */
const concerns = (collision: CollisionState, target: string) =>
  collision.symbols.some((key) => norm(key.split('#')[0] ?? '') === target) ||
  norm(collision.detail).includes(target);

/**
 * Why `sessionId` may not write `path` right now. Pure and deterministic — it runs in the PreToolUse
 * hook, where no model can answer in time — and it reads replicated room state, so every laptop
 * reaches the same answer.
 *
 * Deliberately over-sensitive. Two rules, both stopping BOTH sides:
 *
 * 1. A symbol collision (tier 1+) freezes the files of the symbols in dispute until the agents
 *    accept a contract.
 * 2. Any file another live agent has read, written or declared it will edit is off limits, before
 *    a collision even exists. Waiting for the write to be observed is too late — the first write
 *    from each laptop is already in by then — and Claude Code must read a file before it can
 *    write it, so the read set is the earliest reliable signal there is.
 *
 * Either lifts for a pair once a collision between them about that file is `Accepted` (agents
 * agreed, or a human ran `agg unfreeze`). An escalated collision stays frozen.
 */
export function freezeDenial(
  state: RoomState,
  sessionId: string,
  path: string,
): string | undefined {
  const target = norm(path);
  const collisions = Object.values(state.collisions);
  const settled = (collision: CollisionState) => {
    const negotiation = state.negotiations[collision.collisionId];
    return negotiation !== undefined && SETTLED.has(negotiation.state);
  };

  for (const collision of collisions) {
    if (collision.status !== 'open' || collision.tier === 'FILE_OVERLAP') continue;
    if (!involves(collision, sessionId) || settled(collision)) continue;
    if (!concerns(collision, target)) continue;
    return stopOrder(path, collision.detail);
  }

  for (const other of Object.values(state.sessions)) {
    if (other.sessionId === sessionId || other.status === 'ended') continue;
    const touched = [
      ...(other.writeFiles ?? []),
      ...(other.intent?.files ?? []),
      ...(other.readFiles ?? []),
    ].some((file) => norm(file) === target);
    if (!touched) continue;
    const between = collisions.filter(
      (collision) =>
        involves(collision, sessionId) &&
        involves(collision, other.sessionId) &&
        concerns(collision, target),
    );
    if (between.some(settled)) continue;
    return stopOrder(path, `${other.sessionId} is already working with ${path}.`);
  }
  return undefined;
}
