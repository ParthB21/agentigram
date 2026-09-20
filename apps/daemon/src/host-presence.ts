import type { NewEvent, SessionInfo } from '@agentigram/protocol';

/**
 * Membership belongs to the daemon, not to the host's conversation.
 *
 * A host fires SessionEnd when a turn or a chat finishes — every `agg run` turn is a one-shot
 * process — and SessionStart on each resume, clear and compaction. Passed through, a laptop that
 * is merely between prompts "leaves", stops counting as a collision party (`collide.ts` skips
 * ended sessions), loses its leases, and on the next prompt "joins" again with its read set
 * wiped. The room only ends a session when its daemon does, and a SessionStart is kept only when
 * it teaches us something: the first real model name.
 */
export function isHostPresenceNoise(
  event: NewEvent,
  known: Pick<SessionInfo, 'status' | 'model'> | undefined,
): boolean {
  const payload = event.payload;
  if (payload.type === 'SESSION_ENDED') return payload.reason !== 'daemon_stopped';
  if (payload.type !== 'SESSION_STARTED') return false;
  if (!known || known.status === 'ended') return false;
  return !(known.model === 'unknown' && payload.model !== 'unknown');
}
