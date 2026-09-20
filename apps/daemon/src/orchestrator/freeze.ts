import type { CollisionState, RoomState } from '@agentigram/protocol';

/** Negotiation states in which the agents have agreed, so the freeze lifts. */
const SETTLED = new Set(['Accepted', 'Compiled', 'Verified']);

const norm = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * Loud on purpose. A polite "wait for the contract" reads to a model as a hurdle to route around
 * (a different tool, a shell redirect, a retry); this reads as a stop order it should hand back to
 * its human.
 */
const stopOrder = (path: string, why: string, collisionId: string) =>
  `STOP. Do not modify ${path} — not with Edit or Write, not through the shell, not by any other route. ${why} Agentigram has frozen this file for every agent in the collision until it is settled. Do not retry. Tell the user what you were about to change and that a human can release it with \`agg unfreeze ${collisionId}\`. Then wait.`;

/**
 * Files two sessions are both writing. A tier-0 collision carries no symbols, so the contested
 * paths are recomputed from replicated session state instead of being parsed out of `detail`:
 * what the writer has written, that a live peer has also written or declared it will edit.
 * Reads alone never count, or every reader of a file would block its writers.
 */
function contestedFiles(state: RoomState, collision: CollisionState): Set<string> {
  // A collision needs two live parties. Once one has left, the survivor is alone with the file.
  const live = [collision.writerSession, ...collision.affectedSessions]
    .map((id) => state.sessions[id])
    .filter((session) => session !== undefined && session.status !== 'ended');
  const contested = new Set<string>();
  for (const [i, writer] of live.entries()) {
    const written = new Set((writer?.writeFiles ?? []).map(norm));
    for (const [j, other] of live.entries()) {
      if (i === j) continue;
      for (const file of [...(other?.writeFiles ?? []), ...(other?.intent?.files ?? [])]) {
        if (written.has(norm(file))) contested.add(norm(file));
      }
    }
  }
  return contested;
}

/**
 * Why `sessionId` may not write `path` right now, if a collision it is party to is still being
 * negotiated. Pure and deterministic — it runs in the PreToolUse hook, where no model can answer
 * in time — and it reads replicated room state, so every laptop reaches the same answer.
 *
 * Symbol collisions (tier 1+) freeze the files of the symbols in dispute. A write-write overlap
 * (tier 0, `FILE_OVERLAP`) freezes the contested file for BOTH sides: there is no symbol to
 * negotiate a contract over — two agents rewriting the same file cannot both be right — so it
 * stays frozen until a human accepts the escalation. Tier-0 overlaps found by reads alone stay
 * advisory.
 *
 * A frozen file unfreezes when the negotiation is `Accepted`, which does not wait for the
 * speculative merge that later marks the collision `resolved`.
 */
export function freezeDenial(
  state: RoomState,
  sessionId: string,
  path: string,
): string | undefined {
  const target = norm(path);
  for (const collision of Object.values(state.collisions)) {
    if (collision.status !== 'open') continue;
    if (collision.writerSession !== sessionId && !collision.affectedSessions.includes(sessionId)) {
      continue;
    }
    const negotiation = state.negotiations[collision.collisionId];
    if (negotiation && SETTLED.has(negotiation.state)) continue;
    if (collision.tier === 'FILE_OVERLAP') {
      if (!contestedFiles(state, collision).has(target)) continue;
      return stopOrder(path, `${collision.detail}.`, collision.collisionId);
    }
    if (!collision.symbols.some((key) => norm(key.split('#')[0] ?? '') === target)) continue;
    return stopOrder(path, collision.detail, collision.collisionId);
  }
  return undefined;
}
