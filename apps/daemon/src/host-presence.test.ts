import type { NewEvent } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { isHostPresenceNoise } from './host-presence.js';

const actor = { engineerId: 'e', sessionId: 'payments', kind: 'agent' as const };
const ev = (payload: NewEvent['payload']): NewEvent => ({
  id: 'x',
  roomId: 'r',
  actor,
  source: 'hook',
  payload,
});
const started = (model: string) =>
  ev({ type: 'SESSION_STARTED', sessionId: 'payments', host: 'codex', model, branch: 'main' });

describe('isHostPresenceNoise', () => {
  it('drops a host SessionEnd but keeps the daemon stopping', () => {
    const end = (reason: string) => ev({ type: 'SESSION_ENDED', sessionId: 'payments', reason });
    expect(isHostPresenceNoise(end('other'), { status: 'active', model: 'gpt' })).toBe(true);
    expect(isHostPresenceNoise(end('daemon_stopped'), { status: 'active', model: 'gpt' })).toBe(
      false,
    );
  });

  it('drops a repeated SessionStart for a session already in the room', () => {
    expect(isHostPresenceNoise(started('gpt'), { status: 'active', model: 'gpt' })).toBe(true);
    expect(isHostPresenceNoise(started('unknown'), { status: 'active', model: 'unknown' })).toBe(
      true,
    );
  });

  it('keeps the first SessionStart, a rejoin, and the first real model name', () => {
    expect(isHostPresenceNoise(started('gpt'), undefined)).toBe(false);
    expect(isHostPresenceNoise(started('gpt'), { status: 'ended', model: 'gpt' })).toBe(false);
    expect(isHostPresenceNoise(started('gpt'), { status: 'active', model: 'unknown' })).toBe(false);
  });
});
