import { type Event, emptyRoomState, type Payload } from '@agentigram/protocol';
import { reduce } from '@agentigram/reducer';
import { describe, expect, it } from 'vitest';
import { freezeDenial } from './freeze.js';

type State = ReturnType<typeof emptyRoomState>;

let seq = 0;
function apply(
  state: State,
  session: string | undefined,
  payload: Payload,
  kind: 'agent' | 'human' = 'agent',
) {
  seq += 1;
  const event: Event = {
    id: `e${seq}`,
    seq,
    roomId: 'r',
    ts: new Date(Date.UTC(2026, 8, 20, 12, 0, seq)).toISOString(),
    actor: { engineerId: session ?? 'human', ...(session ? { sessionId: session } : {}), kind },
    source: 'hook',
    payload,
  };
  return reduce(state, event).state;
}

const start = (state: State, id: string) =>
  apply(state, id, {
    type: 'SESSION_STARTED',
    sessionId: id,
    host: 'claude',
    model: 'm',
    branch: 'b',
  });
const read = (state: State, id: string, path: string) =>
  apply(state, id, { type: 'FILE_READ', path });
const write = (state: State, id: string, path: string) =>
  apply(state, id, { type: 'FILE_WRITE', path, worktree: 'w' });

const room = (...ids: string[]) => {
  seq = 0;
  return ids.reduce(start, emptyRoomState('r'));
};

describe('freezeDenial: any overlap stops both sides', () => {
  it('stops a write before it happens when a peer has merely read the file', () => {
    let state = room('a', 'b', 'c');
    state = read(state, 'a', 'CLAUDE.md');
    state = read(state, 'b', 'CLAUDE.md');
    for (const session of ['a', 'b']) {
      const denial = freezeDenial(state, session, 'CLAUDE.md');
      expect(denial).toMatch(/^STOP\./);
      expect(denial).toContain('agg unfreeze --all');
    }
    expect(freezeDenial(state, 'c', 'README.md')).toBeUndefined();
    expect(freezeDenial(state, 'a', 'README.md')).toBeUndefined();
  });

  it('stops on a declared intent and on a peer that has already written', () => {
    let state = room('a', 'b', 'c');
    state = apply(state, 'a', { type: 'INTENT', task: 't', files: ['x.ts'], symbols: [] });
    state = write(state, 'b', 'y.ts');
    expect(freezeDenial(state, 'c', 'x.ts')).toMatch(/^STOP\./);
    expect(freezeDenial(state, 'c', 'y.ts')).toMatch(/^STOP\./);
  });

  it('leaves an agent alone with a file nobody else has touched', () => {
    let state = room('a', 'b');
    state = read(state, 'a', 'CLAUDE.md');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
  });

  it('stays frozen through escalation and lifts only once accepted', () => {
    let state = room('a', 'b');
    state = read(state, 'a', 'CLAUDE.md');
    state = read(state, 'b', 'CLAUDE.md');
    state = apply(state, undefined, {
      type: 'COLLISION',
      collisionId: 'c1',
      tier: 'FILE_OVERLAP',
      symbols: [],
      writerSession: 'a',
      affectedSessions: ['b'],
      detail: 'a is writing CLAUDE.md; b has the same file open.',
    });
    state = apply(state, undefined, { type: 'ESCALATE', collisionId: 'c1', reason: 'x' }, 'human');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toMatch(/^STOP\./);
    state = apply(state, undefined, { type: 'ACCEPT', collisionId: 'c1' }, 'human');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
    expect(freezeDenial(state, 'b', 'CLAUDE.md')).toBeUndefined();
  });

  it('does not let a release on one file free a different file', () => {
    let state = room('a', 'b');
    for (const file of ['CLAUDE.md', 'README.md']) {
      state = read(state, 'a', file);
      state = read(state, 'b', file);
    }
    state = apply(state, undefined, {
      type: 'COLLISION',
      collisionId: 'c1',
      tier: 'FILE_OVERLAP',
      symbols: [],
      writerSession: 'a',
      affectedSessions: ['b'],
      detail: 'a is writing CLAUDE.md; b has the same file open.',
    });
    state = apply(state, undefined, { type: 'ESCALATE', collisionId: 'c1', reason: 'x' }, 'human');
    state = apply(state, undefined, { type: 'ACCEPT', collisionId: 'c1' }, 'human');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
    expect(freezeDenial(state, 'a', 'README.md')).toMatch(/^STOP\./);
  });

  it('does not hold a survivor for a peer that has left', () => {
    let state = room('a', 'b');
    state = read(state, 'a', 'CLAUDE.md');
    state = read(state, 'b', 'CLAUDE.md');
    state = apply(state, 'b', { type: 'SESSION_ENDED', sessionId: 'b' });
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
  });
});
