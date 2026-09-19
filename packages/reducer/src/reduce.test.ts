import { type Event, emptyRoomState, type Payload } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { reduce } from './index.js';

let seq = 0;
const ev = (payload: Payload, sessionId?: string, at = seq + 1): Event => {
  seq = at;
  return {
    id: `e${at}`,
    seq: at,
    roomId: 'r',
    ts: `2026-09-19T00:00:${String(at).padStart(2, '0')}.000Z`,
    actor: { engineerId: 'eng', ...(sessionId ? { sessionId } : {}), kind: 'agent' },
    source: 'hook',
    payload,
  };
};
const started = (sessionId: string) =>
  ev(
    { type: 'SESSION_STARTED', sessionId, host: 'claude-code', model: 'm', branch: 'b' },
    sessionId,
  );

describe('reducer v0', () => {
  it('starts a session and counts it', () => {
    seq = 0;
    const { state } = reduce(emptyRoomState('r'), started('s1'));
    expect(state.sessions.s1?.status).toBe('active');
    expect(state.lastSeq).toBe(1);
    expect(state.teamSummary).toMatchObject({ sessions: 1, activeSessions: 1 });
  });

  it('ends a session', () => {
    seq = 0;
    let s = reduce(emptyRoomState('r'), started('s1')).state;
    s = reduce(s, ev({ type: 'SESSION_ENDED', sessionId: 's1' })).state;
    expect(s.sessions.s1?.status).toBe('ended');
    expect(s.teamSummary.activeSessions).toBe(0);
  });

  it('updates presence from heartbeats using event time, and ignores unknown sessions', () => {
    seq = 0;
    let s = reduce(emptyRoomState('r'), started('s1')).state;
    const hb = ev({ type: 'HEARTBEAT', sessionId: 's1' });
    s = reduce(s, hb).state;
    expect(s.sessions.s1?.lastHeartbeatAt).toBe(hb.ts);
    const ghost = reduce(s, ev({ type: 'HEARTBEAT', sessionId: 'nope' })).state;
    expect(ghost.sessions.nope).toBeUndefined();
  });

  it('stores INTENT on the acting session', () => {
    seq = 0;
    let s = reduce(emptyRoomState('r'), started('s1')).state;
    s = reduce(
      s,
      ev({ type: 'INTENT', task: 'uuid ids', files: ['a.ts'], symbols: [] }, 's1'),
    ).state;
    expect(s.sessions.s1?.intent?.task).toBe('uuid ids');
  });

  it('broadcasts every event to dashboards and persists it', () => {
    seq = 0;
    const e = started('s1');
    const { effects } = reduce(emptyRoomState('r'), e);
    expect(effects).toContainEqual({ kind: 'broadcast', to: 'dashboards', event: e });
    expect(effects).toContainEqual({ kind: 'persist_batch', events: [e] });
  });

  it('is pure: same log in, same state out; input state is untouched', () => {
    seq = 0;
    const log = [started('s1'), ev({ type: 'HEARTBEAT', sessionId: 's1' })];
    const init = emptyRoomState('r');
    const frozen = JSON.stringify(init);
    const run = () => log.reduce((st, e) => reduce(st, e).state, init);
    expect(run()).toEqual(run());
    expect(JSON.stringify(init)).toBe(frozen);
  });

  it('treats an already-applied seq as a no-op', () => {
    seq = 0;
    const e = started('s1');
    const once = reduce(emptyRoomState('r'), e);
    const twice = reduce(once.state, e);
    expect(twice.state).toBe(once.state);
    expect(twice.effects).toEqual([]);
  });
});
