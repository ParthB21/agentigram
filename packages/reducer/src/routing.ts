import { type Event, isAgentVisible, type RoomState } from '@agentigram/protocol';

/** Deterministic delivery. Presentation and market payloads never reach an agent session. */
export function routeEvent(state: RoomState, event: Event): string[] {
  if (!isAgentVisible(event.payload.type)) return [];
  const active = Object.values(state.sessions).filter((session) => session.status !== 'ended');
  const payload = event.payload;
  if (payload.type === 'MESSAGE') {
    return payload.to === 'all' ? active.map((session) => session.sessionId) : [payload.to];
  }
  if (payload.type === 'CONTEXT_QUERY') return [payload.toSession];

  const negotiationId = 'collisionId' in payload ? payload.collisionId : undefined;
  if (typeof negotiationId === 'string') {
    const participants = state.negotiations[negotiationId]?.participants;
    if (participants) return participants;
  }

  const symbols = eventSymbols(event);
  const files = eventFiles(event);
  if (symbols.length > 0 || files.length > 0) {
    return active
      .filter((session) => {
        const sessionSymbols = [...(session.intent?.symbols ?? []), ...(session.readSymbols ?? [])];
        const sessionFiles = [
          ...(session.intent?.files ?? []),
          ...(session.readFiles ?? []),
          ...(session.writeFiles ?? []),
        ];
        return (
          symbols.some((symbol) => sessionSymbols.includes(symbol)) ||
          files.some((file) => sessionFiles.includes(file))
        );
      })
      .map((session) => session.sessionId);
  }

  if (
    ['SESSION_STARTED', 'SESSION_ENDED', 'LEASE_GRANTED', 'LEASE_DENIED'].includes(payload.type)
  ) {
    return active.map((session) => session.sessionId);
  }
  return [];
}

function eventSymbols(event: Event): string[] {
  const payload = event.payload;
  if ('symbols' in payload && Array.isArray(payload.symbols)) return payload.symbols;
  if (payload.type === 'API_DELTA') return payload.changes.map((change) => change.symbol);
  return [];
}

function eventFiles(event: Event): string[] {
  const payload = event.payload;
  if (payload.type === 'FILE_READ' || payload.type === 'FILE_WRITE') return [payload.path];
  if (payload.type === 'INTENT') return payload.files;
  if (payload.type === 'API_DELTA') return [payload.module];
  if (payload.type === 'BUG') return payload.files ?? [];
  return [];
}
