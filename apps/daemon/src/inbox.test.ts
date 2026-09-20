import type { Event } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { shouldRouteToInbox, shouldWake, WakeInbox } from './inbox.js';

const now = Date.parse('2026-09-19T20:00:00.000Z');

function message(
  seq: number,
  from: string,
  to = 'frontend',
  extra: Partial<Extract<Event['payload'], { type: 'MESSAGE' }>> = {},
): Event {
  return {
    id: `event-${seq}`,
    seq,
    roomId: 'hackathon',
    ts: new Date(now).toISOString(),
    actor: { engineerId: `eng-${from}`, sessionId: from, kind: 'agent' },
    source: 'mcp',
    payload: { type: 'MESSAGE', to, text: `message ${seq}`, ...extra },
  };
}

describe('WakeInbox', () => {
  it('claims one sender and conversation atomically, then completes it', () => {
    const inbox = new WakeInbox(() => 'claim-1');
    inbox.enqueue('frontend', message(1, 'backend', 'frontend', { conversationId: 'thread-a' }));
    inbox.enqueue('frontend', message(2, 'payments', 'frontend', { conversationId: 'thread-b' }));
    inbox.enqueue('frontend', message(3, 'backend', 'frontend', { conversationId: 'thread-a' }));

    const claim = inbox.claim('frontend');
    expect(claim?.items.map((item) => item.seq)).toEqual([1, 3]);
    expect(inbox.claimed('frontend', 'claim-1')).toEqual(claim);
    expect(inbox.complete('payments', 'claim-1')).toBeUndefined();
    expect(inbox.complete('frontend', 'claim-1')).toEqual(claim);
    expect(inbox.claim('frontend')?.items.map((item) => item.seq)).toEqual([2]);
  });

  it('requeues a failed claim without losing order or message content', () => {
    const inbox = new WakeInbox(() => 'claim-1');
    inbox.enqueue('frontend', message(1, 'backend'));
    const claim = inbox.claim('frontend');
    expect(claim?.items[0]?.text).toContain('message 1');
    expect(inbox.requeue('frontend', 'claim-1')).toBe(true);
    expect(inbox.claim('frontend')?.items[0]?.seq).toBe(1);
  });

  it('rejects stale, self-authored, hidden, routine and misrouted wake events', () => {
    const current = message(1, 'backend');
    expect(shouldWake(current, 'frontend', ['frontend'], now)).toBe(true);
    expect(shouldWake(message(2, 'frontend'), 'frontend', ['frontend'], now)).toBe(false);
    expect(shouldWake(current, 'payments', ['frontend'], now)).toBe(false);
    expect(
      shouldWake(
        { ...current, ts: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
        'frontend',
        ['frontend'],
        now,
      ),
    ).toBe(false);
    expect(
      shouldWake(
        { ...current, payload: { type: 'PERSONA_LINES', lines: [] } },
        'frontend',
        ['frontend'],
        now,
      ),
    ).toBe(false);
    expect(
      shouldWake(
        { ...current, payload: { type: 'FILE_READ', path: 'src/a.ts' } },
        'frontend',
        ['frontend'],
        now,
      ),
    ).toBe(false);
    expect(
      shouldWake(
        { ...current, payload: { type: 'BLOCKER', text: 'Waiting on the API.' } },
        'frontend',
        ['frontend'],
        now,
      ),
    ).toBe(true);
  });

  it('retains a max-depth message without waking another automatic turn', () => {
    const atLimit = message(1, 'backend', 'frontend', { automationDepth: 3 });
    expect(shouldRouteToInbox(atLimit, 'frontend', ['frontend'], now)).toBe(true);
    expect(shouldWake(atLimit, 'frontend', ['frontend'], now)).toBe(false);
  });

  it('keeps terminal messages for hook context without exposing them to a runner claim', () => {
    const terminal = message(1, 'backend', 'frontend', { automationTerminal: true });
    const inbox = new WakeInbox(() => 'claim-1');
    expect(shouldRouteToInbox(terminal, 'frontend', ['frontend'], now)).toBe(true);
    expect(shouldWake(terminal, 'frontend', ['frontend'], now)).toBe(false);
    inbox.enqueue('frontend', terminal, false);
    expect(inbox.claim('frontend')).toBeUndefined();
    expect(inbox.consume('frontend')).toHaveLength(1);
  });
});
