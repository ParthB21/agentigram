import { redactPayload } from '@agentigram/adapters';
import { speechForEvent } from '@agentigram/personas';
import type { Event, RoomState } from '@agentigram/protocol';

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

/**
 * One arrival is one announcement.
 *
 * A session ends twice whenever its own farewell is followed by the authority noticing the socket
 * close, and re-announces itself on every reconnect. The feed can afford to show both; saying
 * "Bob left the room" twice in Bob's voice sounds like a fault.
 */
export function isRepeatedPresence(before: RoomState, event: Event): boolean {
  const payload = event.payload;
  const status = (sessionId: string) => before.sessions[sessionId]?.status;
  if (payload.type === 'SESSION_STARTED') return status(payload.sessionId) === 'active';
  if (payload.type === 'SESSION_ENDED') return status(payload.sessionId) !== 'active';
  return false;
}

/** Session ids are lower case; a voice should still say a name the way a person would. */
function spoken(sessionId: string): string {
  return sessionId.replace(/[a-z]/, (letter) => letter.toUpperCase());
}
