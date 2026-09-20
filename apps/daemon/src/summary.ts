import type { Event } from '@agentigram/protocol';

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
    case 'SESSION_STARTED':
      return `#${e.seq} ${who} joined the room`;
    case 'SESSION_ENDED':
      return `#${e.seq} ${who} left the room`;
    // Naming the tool is what tells you whether a host's reads are being
    // recognised: an unrecognised read shows up here as a bare TOOL_CALL.
    //
    // The Claude adapter packs a redacted copy of the command into the tool
    // name, which is far too long for a feed line — keep the tool, drop the
    // command, and let the paths carry the detail.
    case 'TOOL_CALL': {
      const tool = String(p.tool).split(':')[0]?.trim() || 'tool';
      return `#${e.seq} ${who} TOOL_CALL ${tool}${p.paths?.length ? ` ${p.paths.join(', ')}` : ''}`;
    }
    default:
      return `#${e.seq} ${who} ${p.type}`;
  }
}
