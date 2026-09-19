import type { Event } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { presentationWindow, toPresentationEvent } from './presentation.js';

function event(seq: number, payload: Event['payload'], causedBy?: number): Event {
  return {
    id: `event-${seq}`,
    seq,
    roomId: 'room',
    ts: '2026-09-19T12:00:00.000Z',
    actor: { engineerId: 'alex', sessionId: 'backend', kind: 'agent' },
    source: 'system',
    ...(causedBy === undefined ? {} : { causedBy }),
    payload,
  };
}

describe('local presentation projection', () => {
  it('keeps only a bounded window of notable events', () => {
    const events = [
      event(1, { type: 'FILE_WRITE', path: 'src/a.ts', worktree: '/repo' }),
      event(2, { type: 'BLOCKER', text: 'first' }),
      event(3, { type: 'BLOCKER', text: 'second' }),
    ];
    expect(presentationWindow(events, 0, 1).map((item) => item.seq)).toEqual([3]);
    expect(presentationWindow(events, 2).map((item) => item.seq)).toEqual([3]);
  });

  it('redacts free text and preserves source sequence grounding', () => {
    const projected = toPresentationEvent(
      event(
        9,
        {
          type: 'COLLISION',
          collisionId: 'c1',
          tier: 'PREDICTED',
          symbols: ['src/user.ts#User.id:property'],
          writerSession: 'backend',
          affectedSessions: ['payments'],
          detail: 'token=super-secret-value breaks checkout',
        },
        7,
      ),
    );
    expect(projected.sourceSeqs).toEqual([7, 9]);
    expect(projected.facts.detail).toBe('token=[REDACTED] breaks checkout');
    expect(projected.fallback).not.toContain('super-secret-value');
  });

  it('describes a clean speculative merge deterministically', () => {
    const projected = toPresentationEvent(
      event(12, {
        type: 'SPEC_MERGE_RESULT',
        baseCommit: 'abc',
        sessions: ['backend', 'payments'],
        typeErrors: [],
        failingTests: [],
        notRun: [],
      }),
    );
    expect(projected.facts.clean).toBe(true);
    expect(projected.fallback).toContain('completed successfully');
  });
});
