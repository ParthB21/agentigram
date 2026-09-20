import type { RoomState } from '@agentigram/protocol';

/** Negotiation states in which the agents have agreed, so the freeze lifts. */
const SETTLED = new Set(['Accepted', 'Compiled', 'Verified']);

const norm = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * Why `sessionId` may not write `path` right now, if a collision it is party to is still being
 * negotiated. Pure and deterministic — it runs in the PreToolUse hook, where no model can answer
 * in time — and it reads replicated room state, so every laptop reaches the same answer.
 *
 * Tier 0 (`FILE_OVERLAP`) is advisory: two agents in one file is not worth stopping either of them.
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
    if (collision.status !== 'open' || collision.tier === 'FILE_OVERLAP') continue;
    if (collision.writerSession !== sessionId && !collision.affectedSessions.includes(sessionId)) {
      continue;
    }
    const negotiation = state.negotiations[collision.collisionId];
    if (negotiation && SETTLED.has(negotiation.state)) continue;
    if (!collision.symbols.some((key) => norm(key.split('#')[0] ?? '') === target)) continue;
    return `${path} is frozen while Agentigram's orchestrator settles a collision: ${collision.detail} Wait for the contract; you will be told when to resume.`;
  }
  return undefined;
}
