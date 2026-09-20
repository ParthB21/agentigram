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
  const speaker = safe.actor.sessionId ?? SYSTEM_SPEAKER;
  const arrival = presenceLine(safe, speaker);
  if (arrival) return arrival;

  // Internal agent instructions and directed briefs from the orchestrator are not spoken aloud
  if (
    safe.payload.type === 'MESSAGE' &&
    (safe.payload.conversationId?.startsWith('orchestrator:plan:') ||
      safe.payload.text?.startsWith("Agentigram's orchestrator has allocated"))
  ) {
    return undefined;
  }

  const line = speechForEvent(safe);
  if (!line) return undefined;
  return { speaker, text: line.text, priority: line.priority };
}

/**
 * Coming and going, in the arriving agent's own voice.
 *
 * Presence is the one piece of activity worth hearing: an agent that has joined is one whose
 * writes can now collide with yours. What it then reads, writes and runs stays silent — that is
 * telemetry, and narrating it would leave no room in the queue for anything anyone said.
 */
function presenceLine(event: Event, speaker: string): SpeechMetadata | undefined {
  const payload = event.payload;
  if (payload.type === 'SESSION_STARTED') {
    return { speaker, text: `${spoken(payload.sessionId)} joined the room.`, priority: 0 };
  }
  if (payload.type === 'SESSION_ENDED') {
    return { speaker, text: `${spoken(payload.sessionId)} left the room.`, priority: 0 };
  }
  return undefined;
}

/** Whether this event is someone coming or going, which is said at most once per arrival. */
export function isPresenceEvent(event: Event): boolean {
  return event.payload.type === 'SESSION_STARTED' || event.payload.type === 'SESSION_ENDED';
}

/**
 * Session ids are usually lower case; a voice should still say a name the way a person would.
 * Only the first character moves, or a session called `Bob` is introduced as "B-Ob".
 */
function spoken(sessionId: string): string {
  return sessionId.charAt(0).toUpperCase() + sessionId.slice(1);
}
