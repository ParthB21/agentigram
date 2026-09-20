import type { Event, Payload } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { buildReport, renderMarkdown } from './index.js';

let seq = 0;
const ev = (session: string | undefined, payload: Payload, offsetS = seq): Event => {
  seq += 1;
  return {
    id: `id-${seq}`,
    seq,
    roomId: 'hackathon',
    ts: new Date(Date.UTC(2026, 8, 20, 12, 0, offsetS)).toISOString(),
    actor: {
      engineerId: session ?? 'system',
      ...(session ? { sessionId: session } : {}),
      kind: session ? 'agent' : 'system',
    },
    source: 'hook',
    payload,
  };
};

function scenario(): Event[] {
  seq = 0;
  return [
    ev('be', {
      type: 'SESSION_STARTED',
      sessionId: 'be',
      host: 'claude',
      model: 'opus',
      branch: 'b',
      task: 'change User.id to uuid in the api',
    }),
    ev('pay', {
      type: 'SESSION_STARTED',
      sessionId: 'pay',
      host: 'codex',
      model: 'gpt',
      branch: 'p',
      task: 'fix checkout bug',
    }),
    ev('be', { type: 'FILE_WRITE', path: 'src/user.ts', worktree: 'w' }),
    ev(undefined, {
      type: 'COLLISION',
      collisionId: 'c1',
      tier: 'PREDICTED',
      symbols: ['src/user.ts#User.id:property'],
      writerSession: 'be',
      affectedSessions: ['pay'],
      detail: 'id type changed',
    }),
    ev('be', {
      type: 'PROPOSAL',
      collisionId: 'c1',
      contract: { symbol: 'User.id', kind: 'type', before: 'number', after: 'string' },
    }),
    ev('pay', { type: 'ACCEPT', collisionId: 'c1' }),
    ev(undefined, {
      type: 'CONTRACT_COMPILED',
      contractId: 'k1',
      collisionId: 'c1',
      checkFiles: [],
    }),
    ev(undefined, { type: 'CONTRACT_RESULT', contractId: 'k1', status: 'pass' }),
    ev('be', { type: 'RUN_VERIFIED', runId: 'r1', sessionId: 'be' }),
    ev(undefined, { type: 'CI_RESULT', commit: 'abcdef123', status: 'fail', sessionId: 'pay' }),
    ev('pay', { type: 'SESSION_ENDED', sessionId: 'pay' }),
  ];
}

describe('session report', () => {
  it('attributes conflicts, resolution and outcomes per agent and model', () => {
    const report = buildReport(scenario(), '2026-09-20T13:00:00.000Z');
    const conflict = report.conflicts[0];
    expect(conflict?.resolution).toBe('verified');
    expect(conflict?.actions.map((a) => a.kind)).toEqual(['PROPOSAL', 'ACCEPT']);
    const be = report.agents.find((a) => a.sessionId === 'be');
    const pay = report.agents.find((a) => a.sessionId === 'pay');
    expect(be).toMatchObject({ outcome: 'pass', collisionsCaused: 1, model: 'opus' });
    expect(pay).toMatchObject({ outcome: 'fail', collisionsAffected: 1, category: 'BUG_FIX' });
    const opus = report.models.find((m) => m.model === 'opus');
    expect(opus).toMatchObject({ passes: 1, conflictsVerified: 1 });
  });

  it('refuses to declare a winner without enough verified sessions', () => {
    const report = buildReport(scenario(), '2026-09-20T13:00:00.000Z');
    expect(report.headToHead.length).toBeGreaterThan(0);
    expect(report.headToHead.every((row) => row.winner === null)).toBe(true);
  });

  it('is deterministic for a given log, so a score cannot be re-rolled', () => {
    const a = buildReport(scenario(), 'now');
    const b = buildReport(scenario(), 'now');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.eventsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes unverified sessions from success rates instead of counting them as failures', () => {
    seq = 0;
    const report = buildReport(
      [
        ev('x', {
          type: 'SESSION_STARTED',
          sessionId: 'x',
          host: 'claude',
          model: 'opus',
          branch: 'b',
        }),
      ],
      'now',
    );
    expect(report.agents[0]?.outcome).toBe('unverified');
    expect(report.models[0]).toMatchObject({ scored: 0, successRate: null });
  });

  it('renders markdown with the conflict story and caveats', () => {
    const md = renderMarkdown(buildReport(scenario(), '2026-09-20T13:00:00.000Z'));
    expect(md).toContain('## Models');
    expect(md).toContain('· verified in');
    expect(md).toContain('PROPOSAL → ACCEPT → contract pass');
    expect(md).toContain('## Notes');
  });
});
