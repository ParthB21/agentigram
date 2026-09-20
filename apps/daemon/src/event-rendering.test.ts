import type { Event } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { agentContextText, speechMetadata } from './event-rendering.js';

function event(payload: Event['payload']): Event {
  return {
    id: 'event-7',
    seq: 7,
    roomId: 'hackathon',
    ts: new Date().toISOString(),
    actor: { engineerId: 'eng-backend', sessionId: 'backend', kind: 'agent' },
    source: 'mcp',
    payload,
  };
}

describe('event rendering boundaries', () => {
  it('keeps the exact redacted message body in agent context', () => {
    const rendered = agentContextText(
      event({
        type: 'MESSAGE',
        to: 'frontend',
        text: 'Use the new route; token=super-secret-value.',
      }),
    );
    expect(rendered).toContain('#7 MESSAGE from=backend to=frontend');
    expect(rendered).toContain('Use the new route; token=[REDACTED]');
    expect(rendered).not.toContain('super-secret-value');
  });

  it('renders safe speech without exposing raw commands', () => {
    expect(
      speechMetadata(event({ type: 'MESSAGE', to: 'frontend', text: 'bearer abcdefghijklmnop' })),
    ).toMatchObject({ speaker: 'Backend', text: 'bearer [REDACTED]', priority: 1 });
    expect(
      speechMetadata(event({ type: 'TOOL_CALL', tool: 'Bash: rm -rf /', phase: 'post' })),
    ).toBeUndefined();
  });
});
