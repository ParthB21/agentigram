import type { Event } from '@clankergram/protocol';

/** One human-readable line per event, for dev-connect. Structured fields go to the logger. */
export function summarise(e: Event): string {
  const who = e.actor.sessionId ?? e.actor.engineerId;
  const p = e.payload;
  switch (p.type) {
    case 'COLLISION':
      return `#${e.seq} ${who} COLLISION ${p.tier} ${p.symbols.join(', ')}`;
    case 'FILE_READ':
    case 'FILE_WRITE':
      return `#${e.seq} ${who} ${p.type} ${p.path}`;
    case 'INTENT':
      return `#${e.seq} ${who} INTENT ${p.task}`;
    case 'MESSAGE':
      return `#${e.seq} ${who} MESSAGE -> ${p.to}`;
    default:
      return `#${e.seq} ${who} ${p.type}`;
  }
}
