import type { Event } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import {
  agentContextText,
  isPresenceEvent,
  speechMetadata,
  SYSTEM_SPEAKER,
} from './event-rendering.js';

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

const joined = {
  type: 'SESSION_STARTED',
  sessionId: 'bob',
  host: 'codex',
  model: 'gpt',
  branch: 'main',
} as const;

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
    ).toMatchObject({ speaker: 'backend', text: 'bearer [REDACTED]', priority: 1 });
    expect(
      speechMetadata(event({ type: 'TOOL_CALL', tool: 'Bash: rm -rf /', phase: 'post' })),
    ).toBeUndefined();
    expect(
      speechMetadata(
        event({
          type: 'MESSAGE',
          to: 'backend',
          text: "Agentigram's orchestrator has allocated this room's work.",
          conversationId: 'orchestrator:plan:backend',
        }),
      ),
    ).toBeUndefined();
  });

  it('attributes a line to the session that said it, not to its persona role', () => {
    // The speaker is both the mute key and the seed the voice is hashed from, so
    // it has to be the same string every laptop knows the speaker by.
    const spoken = speechMetadata(event({ type: 'ACCEPT', collisionId: 'c1' }));
    expect(spoken?.speaker).toBe('backend');
  });

  it('speaks an agent arriving and leaving, but not what it reads or runs', () => {
    // An agent that has joined is one whose writes can now collide with yours.
    // What it then does is telemetry, and narrating it would crowd out speech.
    expect(speechMetadata(event(joined))).toMatchObject({
      speaker: 'backend',
      text: 'Bob joined the room.',
      priority: 0,
    });
    expect(speechMetadata(event({ type: 'SESSION_ENDED', sessionId: 'bob' }))).toMatchObject({
      text: 'Bob left the room.',
    });
    expect(speechMetadata(event({ type: 'FILE_READ', path: 'README.md' }))).toBeUndefined();
    expect(
      speechMetadata(event({ type: 'TOOL_CALL', tool: 'Bash', phase: 'post' })),
    ).toBeUndefined();
  });

  it('says a name the way a person would, whatever case it was joined under', () => {
    // Only the first character moves: `Bob` must not be introduced as "B-Ob".
    expect(speechMetadata(event({ ...joined, sessionId: 'Bob' }))?.text).toBe(
      'Bob joined the room.',
    );
    expect(speechMetadata(event({ ...joined, sessionId: 'backend' }))?.text).toBe(
      'Backend joined the room.',
    );
  });

  it('knows which events are someone coming or going', () => {
    expect(isPresenceEvent(event(joined))).toBe(true);
    expect(isPresenceEvent(event({ type: 'SESSION_ENDED', sessionId: 'bob' }))).toBe(true);
    expect(isPresenceEvent(event({ type: 'FILE_READ', path: 'a.ts' }))).toBe(false);
  });

  it('gives the room a speaker of its own when no session said it', () => {
    // The orchestrator publishes its merged contract and its final report as the
    // room rather than as either agent; those lines still have to be voiced.
    const roomLine = {
      ...event({ type: 'MESSAGE', to: 'all', text: 'The debate is settled.' }),
      actor: { engineerId: 'eng-backend', kind: 'system' as const },
    };
    expect(speechMetadata(roomLine)).toMatchObject({
      speaker: SYSTEM_SPEAKER,
      text: 'The debate is settled.',
    });
  });
});
