import { redactPayload } from '@agentigram/adapters';
import { speechForEvent } from '@agentigram/personas';
import type { Event } from '@agentigram/protocol';

export type SpeechMetadata = {
  speaker: string;
  text: string;
  priority: 0 | 1 | 2 | 3;
};

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

/** Safe deterministic speech; raw commands and non-presentation events return no line. */
export function speechMetadata(event: Event): SpeechMetadata | undefined {
  const line = speechForEvent(safeEvent(event));
  if (!line) return undefined;
  return { speaker: line.speaker, text: line.text, priority: line.priority };
}
