import { emptyRoomState, type RoomState, type SessionInfo } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import {
  assignOwners,
  assignmentBrief,
  buildBrief,
  composePlan,
  deterministicPlan,
  moduleKey,
  planFingerprint,
} from './plan.js';

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: id,
  engineerId: id,
  host: 'claude-code',
  model: 'claude-opus-5',
  branch: 'main',
  status: 'active',
  startedAt: '2026-09-20T00:00:00.000Z',
  lastHeartbeatAt: '2026-09-20T00:00:00.000Z',
  ...over,
});

function room(...sessions: SessionInfo[]): RoomState {
  const state = emptyRoomState('hackathon');
  return {
    ...state,
    sessions: Object.fromEntries(sessions.map((one) => [one.sessionId, one])),
  };
}

const USER_ID = 'src/types/user.ts#User.id:property';

describe('buildBrief', () => {
  it('leaves out sessions that have ended', () => {
    const brief = buildBrief(
      room(session('backend'), session('gone', { status: 'ended', readFiles: ['src/a.ts'] })),
    );
    expect(brief.sessions.map((one) => one.sessionId)).toEqual(['backend']);
  });

  it('ignores paths that say nothing about ownership', () => {
    const brief = buildBrief(
      room(session('backend', { readFiles: ['node_modules/x/index.js', 'src/a.ts'] })),
    );
    expect(brief.sessions[0]?.readFiles).toEqual(['src/a.ts']);
  });

  it('marks a file two sessions care about as contested', () => {
    const brief = buildBrief(
      room(
        session('backend', { writeFiles: ['src/types/user.ts'] }),
        session('payments', { readFiles: ['src/types/user.ts', 'src/checkout.ts'] }),
      ),
    );
    expect(brief.contested).toEqual(['src/types/user.ts']);
  });
});

describe('assignOwners', () => {
  it('gives a contested file to the session writing it, not the one reading it', () => {
    const brief = buildBrief(
      room(
        session('payments', { readFiles: ['src/types/user.ts'] }),
        session('backend', { writeFiles: ['src/types/user.ts'] }),
      ),
    );
    expect(assignOwners(brief).get('src/types/user.ts')).toBe('backend');
  });

  it('honours a preference only for a session that has touched the file', () => {
    const brief = buildBrief(
      room(
        session('backend', { writeFiles: ['src/types/user.ts'] }),
        session('payments', { readFiles: ['src/types/user.ts'] }),
        session('frontend', { readFiles: ['src/ui.ts'] }),
      ),
    );
    const toPayments = assignOwners(brief, new Map([['src/types/user.ts', 'payments']]));
    expect(toPayments.get('src/types/user.ts')).toBe('payments');
    // frontend never opened the file, so the preference is discarded.
    const toFrontend = assignOwners(brief, new Map([['src/types/user.ts', 'frontend']]));
    expect(toFrontend.get('src/types/user.ts')).toBe('backend');
  });

  it('never moves a file out from under a live lease', () => {
    const state = room(
      session('backend', { writeFiles: ['src/types/user.ts'] }),
      session('payments', { readFiles: ['src/types/user.ts'] }),
    );
    const leased: RoomState = {
      ...state,
      leases: {
        l1: {
          leaseId: 'l1',
          sessionId: 'payments',
          symbols: [USER_ID],
          fencingToken: 4,
          expiresAt: '2026-09-20T01:00:00.000Z',
        },
      },
    };
    expect(assignOwners(buildBrief(leased)).get('src/types/user.ts')).toBe('payments');
  });
});

describe('deterministicPlan', () => {
  const state = room(
    session('backend', {
      writeFiles: ['src/types/user.ts'],
      intent: { task: 'Move User.id to a UUID', files: ['src/types/user.ts'], symbols: [USER_ID] },
    }),
    session('payments', {
      readFiles: ['src/types/user.ts', 'src/checkout.ts'],
      readSymbols: [USER_ID],
    }),
  );

  it('gives each contested file one owner and tells the other to stay off it', () => {
    const plan = deterministicPlan(buildBrief(state));
    const backend = plan.assignments.find((one) => one.sessionId === 'backend');
    const payments = plan.assignments.find((one) => one.sessionId === 'payments');
    expect(backend?.owns).toContain('src/types/user.ts');
    expect(payments?.owns).toEqual(['src/checkout.ts']);
    expect(payments?.avoid).toEqual([{ path: 'src/types/user.ts', owner: 'backend' }]);
  });

  it('leases only the contested file, using a symbol the room has actually seen', () => {
    const plan = deterministicPlan(buildBrief(state));
    const backend = plan.assignments.find((one) => one.sessionId === 'backend');
    expect(backend?.claim).toEqual([USER_ID]);
    const payments = plan.assignments.find((one) => one.sessionId === 'payments');
    expect(payments?.claim).toEqual([]);
  });

  it('keeps an agent’s own declared task rather than inventing one', () => {
    const plan = deterministicPlan(buildBrief(state));
    expect(plan.assignments.find((one) => one.sessionId === 'backend')?.task).toBe(
      'Move User.id to a UUID',
    );
  });

  it('falls back to a whole-file claim when no symbol is known', () => {
    const plan = deterministicPlan(
      buildBrief(
        room(
          session('a', { writeFiles: ['README.md'] }),
          session('b', { readFiles: ['README.md'] }),
        ),
      ),
    );
    expect(plan.assignments.find((one) => one.sessionId === 'a')?.claim).toEqual([
      'README.md#README:module',
    ]);
  });

  it('says so plainly when nothing is shared', () => {
    const plan = deterministicPlan(
      buildBrief(
        room(session('a', { writeFiles: ['src/a.ts'] }), session('b', { writeFiles: ['src/b.ts'] })),
      ),
    );
    expect(plan.handoffs).toEqual([]);
    expect(plan.assignments.every((one) => one.claim.length === 0)).toBe(true);
    expect(plan.summary).toContain('no shared files');
  });
});

describe('planFingerprint', () => {
  it('is stable for the same allocation and changes when ownership moves', () => {
    const brief = buildBrief(
      room(
        session('backend', { writeFiles: ['src/types/user.ts'] }),
        session('payments', { readFiles: ['src/types/user.ts'] }),
      ),
    );
    expect(planFingerprint(deterministicPlan(brief))).toBe(
      planFingerprint(deterministicPlan(brief)),
    );
    const moved = composePlan(brief, new Map([['src/types/user.ts', 'payments']]));
    expect(planFingerprint(moved)).not.toBe(planFingerprint(deterministicPlan(brief)));
  });
});

describe('moduleKey', () => {
  it('builds a valid key for a file whose name has extra dots', () => {
    expect(moduleKey('src/a.test.ts')).toBe('src/a.test.ts#a-test:module');
  });
});

describe('assignmentBrief', () => {
  it('names what the agent owns and what it must not touch', () => {
    const brief = buildBrief(
      room(
        session('backend', { writeFiles: ['src/types/user.ts'] }),
        session('payments', { readFiles: ['src/types/user.ts', 'src/checkout.ts'] }),
      ),
    );
    const plan = deterministicPlan(brief);
    const payments = plan.assignments.find((one) => one.sessionId === 'payments');
    const text = assignmentBrief(payments as never, plan);
    expect(text).toContain('Do not edit src/types/user.ts');
    expect(text).toContain('backend owns it');
  });
});
