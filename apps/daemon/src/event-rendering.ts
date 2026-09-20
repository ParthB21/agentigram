import { redactPayload } from '@agentigram/adapters';
import { speechForEvent } from '@agentigram/personas';
import type { Event } from '@agentigram/protocol';

export type SpeechMetadata = {
  speaker: string;
  text: string;
  priority: 0 | 1 | 2 | 3;
};

/**
 * Who a line with no session of its own is attributed to. The orchestrator speaks as the room
 * itself when it merges a debate or reports the outcome, and those lines still have to be
 * mutable, voiced and labelled like any other speaker. Kept in step with `SYSTEM_SPEAKER` in
 * `apps/tui/lib/speech/index.js`, which is what decides whether it is heard.
 */
export const SYSTEM_SPEAKER = 'agentigram';

function safeEvent(event: Event): Event {
  return { ...event, payload: redactPayload(event.payload) } as Event;
}

/** Exact coordination data for an agent, distinct from the terse human feed summary. */
export function agentContextText(event: Event): string {
  const safe = safeEvent(event);
  const from = safe.actor.sessionId ?? safe.actor.engineerId;
  if (safe.payload.type === 'MESSAGE') {
    return [`#${safe.seq} MESSAGE from=${from} to=${safe.payload.to}`, safe.payload.text].join(
      '\n',
    );
  }
  return `#${safe.seq} from=${from} type=${safe.payload.type} payload=${JSON.stringify(safe.payload)}`;
}

/**
 * Safe deterministic speech; raw commands and non-presentation events return no line.
 *
 * The speaker is the session id rather than the persona role, because it is both the key a
 * listener mutes and the seed the voice is hashed from: a line attributed to "Backend" on one
 * laptop and to `backend` on another would be a different voice and a different mute button.
 */
export function speechMetadata(event: Event): SpeechMetadata | undefined {
  const safe = safeEvent(event);
  const line = speechForEvent(safe);
  if (!line) return undefined;
  return {
    speaker: safe.actor.sessionId ?? SYSTEM_SPEAKER,
    text: line.text,
    priority: line.priority,
  };
}
