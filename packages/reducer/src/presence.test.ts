import { emptyRoomState, type RoomState } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { presenceMap, STALE_AFTER_MS, sessionPresence } from './presence.js';

const T0 = Date.parse('2026-09-19T12:00:00.000Z');
const state = (status: 'active' | 'ended' = 'active'): RoomState => ({
  ...emptyRoomState('r'),
  sessions: {
    s1: {
      sessionId: 's1',
      engineerId: 'e',
      host: 'claude-code',
      model: 'm',
      branch: 'b',
      status,
      startedAt: new Date(T0).toISOString(),
      lastHeartbeatAt: new Date(T0).toISOString(),
    },
  },
});

describe('presence', () => {
  it('is live up to 30 s after the last heartbeat and stale after', () => {
    expect(sessionPresence(state(), 's1', T0 + STALE_AFTER_MS)).toBe('live');
    expect(sessionPresence(state(), 's1', T0 + STALE_AFTER_MS + 1)).toBe('stale');
  });

  it('a newer connection signal keeps a session live', () => {
    expect(sessionPresence(state(), 's1', T0 + 60_000, T0 + 50_000)).toBe('live');
  });

  it('ended sessions stay ended; unknown sessions are undefined', () => {
    expect(sessionPresence(state('ended'), 's1', T0)).toBe('ended');
    expect(sessionPresence(state(), 'nope', T0)).toBeUndefined();
  });

  it('maps every session, and takes time from the caller (no clock)', () => {
    expect(presenceMap(state(), T0 + 100_000)).toEqual({ s1: 'stale' });
  });
});
