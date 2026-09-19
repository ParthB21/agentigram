import { emptyRoomState } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyDaemonSnapshot,
  applyFrame,
  initialStream,
  localBridgeUrl,
  MAX_EVENTS,
  roomSocketUrl,
} from './room-stream';

const event = (seq: number) => ({
  id: `e${seq}`,
  seq,
  roomId: 'r',
  ts: 'x',
  actor: { engineerId: 'e', kind: 'agent' as const },
  source: 'hook' as const,
  payload: { type: 'HEARTBEAT' as const, sessionId: 's' },
});
const frame = (events: ReturnType<typeof event>[]) => JSON.stringify({ type: 'EVENTS', events });

describe('room stream', () => {
  it('builds the room socket url', () => {
    expect(roomSocketUrl('ws://localhost:8787/', 'hackathon')).toBe(
      'ws://localhost:8787/room/hackathon',
    );
    expect(roomSocketUrl('ws://h', 'a b')).toBe('ws://h/room/a%20b');
    expect(localBridgeUrl('a b')).toBe('/api/rooms/a%20b/stream');
  });

  it('applies local daemon snapshots without replaying them over the snapshot state', () => {
    const roomState = emptyRoomState('r');
    roomState.lastSeq = 3;
    const next = applyDaemonSnapshot(
      initialStream('r'),
      JSON.stringify({ roomId: 'r', transport: 'connected', roomState, events: [event(3)] }),
    );
    expect(next.status).toBe('live');
    expect(next.source).toBe('daemon');
    expect(next.lastSeq).toBe(3);
    expect(next.events.map((item) => item.seq)).toEqual([3]);
    expect(next.roomState.lastSeq).toBe(3);
  });

  it('surfaces a replicated but disconnected daemon as read-only', () => {
    const roomState = emptyRoomState('r');
    const next = applyDaemonSnapshot(
      initialStream('r'),
      JSON.stringify({ roomId: 'r', transport: 'read-only', roomState, events: [] }),
    );
    expect(next.status).toBe('read-only');
    expect(next.transport).toBe('read-only');
  });

  it('appends events in order and ignores already-seen seqs', () => {
    let s = applyFrame(initialStream('r'), frame([event(2), event(1)]));
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    s = applyFrame(s, frame([event(2), event(3)]));
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.lastSeq).toBe(3);
    expect(s.status).toBe('live');
  });

  it('drops malformed frames without losing state', () => {
    const s = applyFrame(initialStream('r'), frame([event(1)]));
    expect(applyFrame(s, 'not json').events).toHaveLength(1);
    expect(applyFrame(s, JSON.stringify({ type: 'EVENTS', events: [{ seq: 'x' }] })).error).toMatch(
      /invalid/,
    );
  });

  it('goes live on WELCOME and surfaces server errors', () => {
    const w = applyFrame(
      initialStream('r'),
      JSON.stringify({ type: 'WELCOME', roomState: emptyRoomState('r'), fromSeq: 0 }),
    );
    expect(w.status).toBe('live');
    expect(
      applyFrame(w, JSON.stringify({ type: 'ERROR', code: 'UNAUTHORIZED', message: 'no' })).error,
    ).toBe('UNAUTHORIZED: no');
  });

  it('bounds memory', () => {
    const s = applyFrame(
      initialStream('r'),
      frame(Array.from({ length: MAX_EVENTS + 20 }, (_, i) => event(i + 1))),
    );
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect(s.events.at(-1)?.seq).toBe(MAX_EVENTS + 20);
  });
});
