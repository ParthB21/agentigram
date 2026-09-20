import {
  type Event,
  emptyRoomState,
  type RoomState,
  type SessionInfo,
  symbolKey,
} from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { detectCollisions } from './collide.js';

const USER_ID = symbolKey('src/types/user.ts', 'User', 'id', 'property');
const WRITTEN = 'src/types/user.ts';
const TASK = 'Change User.id to a UUID';

function session(sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId,
    engineerId: sessionId,
    host: 'claude-code',
    model: 'claude',
    branch: 'main',
    status: 'active',
    startedAt: '2026-09-19T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-19T00:00:00.000Z',
    ...extra,
  };
}

/**
 * The room as it stands *after* the reducer has applied Backend's intent — which is the order the
 * daemon calls this in, and the reason a write can be narrowed to declared symbols at all.
 */
function room(overrides: { backend?: Partial<SessionInfo>; payments?: Partial<SessionInfo> } = {}) {
  return {
    ...emptyRoomState('hackathon'),
    sessions: {
      backend: session('backend', {
        intent: { task: TASK, files: ['src/types/user.ts'], symbols: [USER_ID] },
        ...overrides.backend,
      }),
      payments: session('payments', {
        readFiles: ['src/types/user.ts', 'src/checkout.ts'],
        readSymbols: [USER_ID],
        ...overrides.payments,
      }),
    },
  } satisfies RoomState;
}

function event(payload: Event['payload'], sessionId = 'backend', seq = 1): Event {
  return {
    id: `e${seq}`,
    seq,
    roomId: 'hackathon',
    ts: '2026-09-19T00:00:00.000Z',
    actor: { engineerId: sessionId, sessionId, kind: 'agent' },
    source: 'mcp',
    payload,
  };
}

const intent = event({
  type: 'INTENT',
  task: TASK,
  files: ['src/types/user.ts'],
  symbols: [USER_ID],
});
const write = event({ type: 'FILE_WRITE', path: 'src/types/user.ts', worktree: '/repo' });

describe('detectCollisions', () => {
  it('opens a tier-1 PREDICTED collision when an intent hits a symbol a peer has read', () => {
    const [collision, ...rest] = detectCollisions(room(), intent);
    expect(rest).toEqual([]);
    expect(collision?.tier).toBe('PREDICTED');
    expect(collision?.symbols).toEqual([USER_ID]);
    expect(collision?.writerSession).toBe('backend');
    expect(collision?.affectedSessions).toEqual(['payments']);
    expect(collision?.detail).toContain(TASK);
    expect(collision?.detail).toContain('User.id');
    expect(collision?.detail).not.toContain(':property');
    expect(collision?.confidence).toBe(0.8);
  });

  it('falls back to tier-0 FILE_OVERLAP when only the path matches', () => {
    const [collision] = detectCollisions(room({ payments: { readSymbols: [] } }), intent);
    expect(collision?.tier).toBe('FILE_OVERLAP');
    expect(collision?.symbols).toEqual([]);
    expect(collision?.confidence).toBe(0.4);
  });

  it('narrows a FILE_WRITE to the symbols that session announced for that file', () => {
    const state = room({
      backend: {
        intent: {
          task: TASK,
          files: ['src/types/user.ts', 'src/other.ts'],
          symbols: [USER_ID, symbolKey('src/other.ts', 'Other', undefined, 'function')],
        },
      },
    });
    const [collision] = detectCollisions(state, write);
    expect(collision?.tier).toBe('PREDICTED');
    expect(collision?.symbols).toEqual([USER_ID]);
  });

  it('is stable: the same overlap does not re-open an already-open collision', () => {
    const state = room();
    const first = detectCollisions(state, intent)[0];
    expect(first).toBeDefined();
    const collisionId = first?.collisionId ?? '';
    const opened: RoomState = {
      ...state,
      collisions: {
        [collisionId]: {
          collisionId,
          tier: 'PREDICTED',
          symbols: [USER_ID],
          writerSession: 'backend',
          affectedSessions: ['payments'],
          detail: 'already negotiating',
          status: 'open',
          openedSeq: 1,
        },
      },
    };
    expect(detectCollisions(opened, intent)).toEqual([]);
    // A resolved one may re-open: the peer read it again after the contract landed.
    const resolved: RoomState = {
      ...opened,
      collisions: {
        [collisionId]: { ...opened.collisions[collisionId], status: 'resolved' } as never,
      },
    };
    expect(detectCollisions(resolved, intent)).toHaveLength(1);
  });

  it('ignores ended sessions and events that are not writes', () => {
    expect(detectCollisions(room({ payments: { status: 'ended' } }), intent)).toEqual([]);
    const read = event({ type: 'FILE_READ', path: 'src/types/user.ts' });
    expect(detectCollisions(room(), read)).toEqual([]);
  });

  it('collides with a symbol the peer only announced, for hosts with no working hooks', () => {
    // payments has read nothing — all it could do was call the MCP tool.
    const state = room({
      payments: {
        readFiles: [],
        readSymbols: [],
        intent: { task: 'Charge by user id', files: ['src/checkout.ts'], symbols: [USER_ID] },
      },
    });
    const [collision] = detectCollisions(state, intent);
    expect(collision?.tier).toBe('PREDICTED');
    expect(collision?.symbols).toEqual([USER_ID]);
  });

  it('leaves write-vs-write to the reducer, which already opens that collision', () => {
    // payments has written the file but never read it: `applyFileWrite` owns this.
    const state = room({ payments: { readFiles: [], readSymbols: [], writeFiles: [WRITTEN] } });
    expect(detectCollisions(state, write)).toEqual([]);
  });

  it('collides an intent with a file a peer merely claimed, so two claimants both get a collision', () => {
    // payments never read the file; it only declared it would edit it.
    const state = room({
      payments: {
        readFiles: [],
        readSymbols: [],
        intent: { task: 't', files: [WRITTEN], symbols: [] },
      },
    });
    const claim = event({ type: 'INTENT', task: TASK, files: [WRITTEN], symbols: [] });
    const [collision] = detectCollisions(state, claim);
    expect(collision?.tier).toBe('FILE_OVERLAP');
    expect(collision?.affectedSessions).toEqual(['payments']);
  });

  it('does not collide a session with itself', () => {
    const solo = {
      ...emptyRoomState('hackathon'),
      sessions: {
        backend: session('backend', {
          readFiles: ['src/types/user.ts'],
          readSymbols: [USER_ID],
          intent: { task: TASK, files: ['src/types/user.ts'], symbols: [USER_ID] },
        }),
      },
    } satisfies RoomState;
    expect(detectCollisions(solo, intent)).toEqual([]);
  });
});
