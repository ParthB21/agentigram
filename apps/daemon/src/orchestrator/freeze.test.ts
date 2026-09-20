import { type Event, emptyRoomState, type Payload } from '@agentigram/protocol';
import { reduce } from '@agentigram/reducer';
import { describe, expect, it } from 'vitest';
import { freezeDenial } from './freeze.js';

let seq = 0;
function apply(
  state: ReturnType<typeof emptyRoomState>,
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

const start = (state: ReturnType<typeof emptyRoomState>, id: string) =>
  apply(state, id, {
    type: 'SESSION_STARTED',
    sessionId: id,
    host: 'claude',
    model: 'm',
    branch: 'b',
  });
const write = (state: ReturnType<typeof emptyRoomState>, id: string, path: string) =>
  apply(state, id, { type: 'FILE_WRITE', path, worktree: 'w' });

function twoLaptopsOneFile() {
  seq = 0;
  let state = emptyRoomState('r');
  state = start(state, 'a');
  state = start(state, 'b');
  state = start(state, 'c');
  state = write(state, 'a', 'CLAUDE.md');
  state = write(state, 'b', 'CLAUDE.md');
  return state;
}

describe('freezeDenial: two agents writing the same file', () => {
  it('stops BOTH writers on the contested file, with an order that says stop', () => {
    const state = twoLaptopsOneFile();
    for (const session of ['a', 'b']) {
      const denial = freezeDenial(state, session, 'CLAUDE.md');
      expect(denial).toMatch(/^STOP\./);
      expect(denial).toContain('agg unfreeze');
    }
  });

  it('leaves other files, and uninvolved sessions, alone', () => {
    const state = twoLaptopsOneFile();
    expect(freezeDenial(state, 'a', 'README.md')).toBeUndefined();
    expect(freezeDenial(state, 'c', 'CLAUDE.md')).toBeUndefined();
  });

  it('does not freeze a file another agent has only read', () => {
    seq = 0;
    let state = emptyRoomState('r');
    state = start(state, 'a');
    state = start(state, 'b');
    state = apply(state, 'b', { type: 'FILE_READ', path: 'CLAUDE.md' });
    state = write(state, 'a', 'CLAUDE.md');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
  });

  it('stays frozen through escalation and lifts only when a human accepts', () => {
    let state = twoLaptopsOneFile();
    const id = Object.keys(state.collisions)[0] as string;
    state = apply(state, undefined, { type: 'ESCALATE', collisionId: id, reason: 'x' }, 'human');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toMatch(/^STOP\./);
    state = apply(state, undefined, { type: 'ACCEPT', collisionId: id }, 'human');
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
    expect(freezeDenial(state, 'b', 'CLAUDE.md')).toBeUndefined();
  });

  it('does not freeze a survivor for a peer that has left', () => {
    let state = twoLaptopsOneFile();
    state = apply(state, 'b', { type: 'SESSION_ENDED', sessionId: 'b' });
    expect(freezeDenial(state, 'a', 'CLAUDE.md')).toBeUndefined();
  });
});
