import type { Event } from '@agentigram/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { WRITE_COOLDOWN_MS, WriteNarrator } from './write-narration.js';

let seq = 0;
beforeEach(() => {
  seq = 0;
});

/** `sessionId: null` is the person at the keyboard, which the watcher also reports. */
function write(path: string, sessionId: string | null = 'backend'): Event {
  seq += 1;
  return {
    id: `event-${seq}`,
    seq,
    roomId: 'hackathon',
    ts: new Date().toISOString(),
    actor: {
      engineerId: 'eng-backend',
      ...(sessionId ? { sessionId } : {}),
      kind: sessionId ? 'agent' : 'human',
    },
    source: 'hook',
    payload: { type: 'FILE_WRITE', path, worktree: '/repo' },
  } as Event;
}

describe('narrating what an agent is working on', () => {
  it('says the first file at once and then stays quiet through the burst', () => {
    const narrator = new WriteNarrator();
    const first = narrator.line(write('src/types/user.ts'), 0);
    expect(first).toMatchObject({ speaker: 'backend', priority: 0 });
    expect(first?.text).toMatch(/^\S+ user\.ts\.$/);

    // A refactor saves far faster than a voice reads; the rest of the burst is silent.
    expect(narrator.line(write('src/checkout.ts'), 1_000)).toBeUndefined();
    expect(narrator.line(write('src/cart.ts'), 2_000)).toBeUndefined();
    expect(narrator.line(write('src/orders.ts'), 3_000)).toBeUndefined();
  });

  it('accounts for everything saved while it was quiet', () => {
    const narrator = new WriteNarrator();
    narrator.line(write('src/types/user.ts'), 0);
    narrator.line(write('src/checkout.ts'), 1_000);
    narrator.line(write('src/cart.ts'), 2_000);
    narrator.line(write('src/orders.ts'), 3_000);

    // Two names and a count, the way a person reports a batch of edits.
    expect(narrator.line(write('src/refunds.ts'), WRITE_COOLDOWN_MS)?.text).toMatch(
      /^\S+ checkout\.ts, cart\.ts and two other files\.$/,
    );
  });

  it('names two files without a count', () => {
    const narrator = new WriteNarrator();
    narrator.line(write('src/a.ts'), 0);
    narrator.line(write('src/b.ts'), 1_000);
    expect(narrator.line(write('src/c.ts'), WRITE_COOLDOWN_MS)?.text).toMatch(
      /b\.ts and c\.ts\.$/,
    );
  });

  it('counts one other file in the singular', () => {
    const narrator = new WriteNarrator();
    narrator.line(write('src/a.ts'), 0);
    narrator.line(write('src/b.ts'), 1_000);
    narrator.line(write('src/c.ts'), 1_500);
    expect(narrator.line(write('src/d.ts'), WRITE_COOLDOWN_MS)?.text).toMatch(
      /and one other file\.$/,
    );
  });

  it('gives each agent its own turn to speak', () => {
    const narrator = new WriteNarrator();
    expect(narrator.line(write('src/a.ts', 'backend'), 0)).toBeDefined();
    // One agent's burst must not silence another's first word.
    expect(narrator.line(write('src/b.ts', 'payments'), 10)).toBeDefined();
    expect(narrator.line(write('src/c.ts', 'backend'), 20)).toBeUndefined();
  });

  it('does not read the engineer their own edits back', () => {
    const narrator = new WriteNarrator();
    expect(narrator.line(write('README.md', null), 0)).toBeUndefined();
  });

  it('reports one save once, however many sources notice it', () => {
    // A hook and the watcher flush can both see a single write.
    const narrator = new WriteNarrator();
    narrator.line(write('src/a.ts'), 0);
    narrator.line(write('src/types/user.ts'), 1_000);
    narrator.line(write('src/types/user.ts'), 1_100);
    expect(narrator.line(write('src/b.ts'), WRITE_COOLDOWN_MS)?.text).toMatch(
      /^\S+ user\.ts and b\.ts\.$/,
    );
  });

  it('varies the wording without becoming unpredictable', () => {
    // Indexed by the event's own sequence number: reproducible, not random.
    const verb = (at: number) => {
      seq = at - 1;
      return new WriteNarrator().line(write('src/a.ts'), 0)?.text.split(' ')[0];
    };
    expect(verb(7)).toBe(verb(7));
    expect(new Set([verb(1), verb(2), verb(3), verb(4)]).size).toBeGreaterThan(1);
  });

  it('stays silent for anything that is not a write', () => {
    const narrator = new WriteNarrator();
    const read = { ...write('src/a.ts'), payload: { type: 'FILE_READ', path: 'src/a.ts' } } as Event;
    expect(narrator.line(read, 0)).toBeUndefined();
  });
});
