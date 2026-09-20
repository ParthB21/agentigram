import type { Event } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONAS, render, speechForEvent } from './index.js';

const event = (seq: number, payload: Event['payload']): Event => ({
  id: `event-${seq}`,
  seq,
  roomId: 'hackathon',
  ts: '2026-09-19T14:30:00Z',
  actor: { engineerId: 'backend-engineer', sessionId: 'backend', kind: 'agent' },
  source: 'system',
  payload,
});

describe('@agentigram/personas', () => {
  it('renders ordered dialogue linked to source sequences', async () => {
    const lines = await render(
      [
        event(2, { type: 'FILE_WRITE', path: 'src/user.ts', worktree: '/repo' }),
        event(1, { type: 'INTENT', task: 'migrate ids', files: [], symbols: [] }),
      ],
      DEFAULT_PERSONAS,
    );
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);
    expect(lines[0]!.speaker).toBe('Backend');
  });

  it('batches notable events through an injected renderer and sanitises output', async () => {
    const collision = event(3, {
      type: 'COLLISION',
      collisionId: 'c1',
      tier: 'PREDICTED',
      symbols: ['src/types/user.ts#User.id:property'],
      writerSession: 'backend',
      affectedSessions: ['payments'],
      detail: 'checkout reads the old type',
    });
    const lines = await render([collision], DEFAULT_PERSONAS, {
      notableRenderer: async () => [
        { speaker: 'Backend', text: 'That stupid interface moved.', seq: 3 },
      ],
    });
    expect(lines).toEqual([
      { speaker: 'Backend', text: 'That incorrect interface moved.', seq: 3 },
    ]);
  });

  it('falls back when generated lines are not linked to an input event', async () => {
    const collision = event(4, {
      type: 'COLLISION',
      collisionId: 'c1',
      tier: 'SEMANTIC',
      symbols: [],
      writerSession: 'backend',
      affectedSessions: [],
      detail: 'break',
    });
    const lines = await render([collision], DEFAULT_PERSONAS, {
      notableRenderer: async () => [{ speaker: 'Backend', text: 'invented', seq: 999 }],
    });
    expect(lines).toEqual([
      {
        speaker: 'Backend',
        text: 'semantic collision on the affected interface. break',
        seq: 4,
      },
    ]);
  });

  it('renders exact messages as synchronous speech metadata', () => {
    expect(
      speechForEvent(event(5, { type: 'MESSAGE', to: 'frontend', text: 'The API is ready.' })),
    ).toEqual({
      speaker: 'Backend',
      text: 'The API is ready.',
      seq: 5,
      priority: 1,
      replyTo: 'frontend',
    });
  });

  it('does not expose raw tool calls as speech', () => {
    expect(
      speechForEvent(event(6, { type: 'TOOL_CALL', tool: 'Bash: token=secret', phase: 'post' })),
    ).toBeUndefined();
  });
});
