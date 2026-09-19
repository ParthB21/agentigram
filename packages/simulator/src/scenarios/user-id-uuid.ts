import { isAgentVisible, type Payload, symbolKey } from '@clankergram/protocol';
import type { Scenario, ScenarioSession, ScenarioStep } from '../scenario.js';

/**
 * The canonical demo (CLAUDE.md → "The canonical scenario"): Backend changes `User.id` from
 * `number` to a UUID `string`; Payments has read `user.ts` and `checkout.ts`. Expected outcome:
 * tier-1 PREDICTED, tier-2 SEMANTIC, a lease denial for Payments, proposal/accept, a compiled
 * contract and a verified run. Every part should have at least one test that consumes this.
 */

const USER = 'src/types/user.ts';
const CHECKOUT = 'src/checkout/checkout.ts';
export const USER_ID = symbolKey(USER, 'User', 'id', 'property');
const USER_TYPE = symbolKey(USER, 'User', 'interface');

export const sessions: ScenarioSession[] = [
  {
    sessionId: 'frontend',
    engineerId: 'eng-frontend',
    role: 'Frontend',
    model: 'claude-sonnet-5',
    host: 'claude-code',
    branch: 'p/frontend',
  },
  {
    sessionId: 'backend',
    engineerId: 'eng-backend',
    role: 'Backend',
    model: 'claude-opus-5',
    host: 'claude-code',
    branch: 'p/backend',
  },
  {
    sessionId: 'payments',
    engineerId: 'eng-payments',
    role: 'Payments',
    model: 'gpt-5',
    host: 'codex',
    branch: 'p/payments',
  },
  {
    sessionId: 'security',
    engineerId: 'eng-security',
    role: 'Security',
    model: 'gemini-3-pro',
    host: 'gemini-cli',
    branch: 'p/security',
  },
];

const contract = {
  symbol: 'src/types/user.ts#User.id',
  kind: 'type',
  before: 'number',
  after: 'string',
  constraint: 'UUID v4',
  migration: 'all callers update by lease release',
} as const;

const system = { engineerId: 'system', kind: 'system' } as const;

/** Builds steps in order; `seq` of a step is its 1-based position, as the coordinator would assign. */
class Builder {
  readonly steps: ScenarioStep[] = [];

  private add(
    atMs: number,
    actor: ScenarioStep['event']['actor'],
    source: ScenarioStep['event']['source'],
    payload: Payload,
    causedBy?: number,
  ): number {
    const n = this.steps.length + 1;
    this.steps.push({
      atMs,
      event: {
        id: `user-id-uuid-${n}`,
        roomId: 'sim',
        actor,
        source,
        payload,
        ...(causedBy ? { causedBy } : {}),
      },
    });
    return n;
  }

  agent(
    atMs: number,
    sessionId: string,
    source: 'hook' | 'watcher' | 'mcp',
    payload: Payload,
    causedBy?: number,
  ) {
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    return this.add(
      atMs,
      { engineerId: s.engineerId, sessionId, kind: 'agent' },
      source,
      payload,
      causedBy,
    );
  }

  sys(atMs: number, payload: Payload, causedBy?: number) {
    return this.add(atMs, system, 'system', payload, causedBy);
  }
}

function build(): ScenarioStep[] {
  const b = new Builder();
  sessions.forEach((s, i) => {
    b.agent(i * 100, s.sessionId, 'hook', {
      type: 'SESSION_STARTED',
      sessionId: s.sessionId,
      host: s.host,
      model: s.model,
      branch: s.branch,
      role: s.role,
    });
  });

  // Payments reads what it depends on. This is the read set the tier-1 check intersects.
  b.agent(500, 'payments', 'hook', {
    type: 'FILE_READ',
    path: USER,
    symbols: [USER_ID, USER_TYPE],
  });
  b.agent(600, 'payments', 'hook', { type: 'FILE_READ', path: CHECKOUT });
  b.agent(700, 'security', 'mcp', {
    type: 'DISCOVERY',
    text: 'Session tokens use user.id as the sub claim.',
    symbols: [USER_ID],
  });

  // Tier 1: intent before any edit.
  const intent = b.agent(1000, 'backend', 'mcp', {
    type: 'INTENT',
    task: 'Migrate User.id from number to UUID string',
    files: [USER],
    symbols: [USER_ID],
  });
  const claim = b.agent(
    1010,
    'backend',
    'mcp',
    { type: 'LEASE_REQUESTED', symbols: [USER_ID], ttlMs: 600_000 },
    intent,
  );
  b.sys(
    1020,
    {
      type: 'LEASE_GRANTED',
      leaseId: 'lease-1',
      symbols: [USER_ID],
      fencingToken: claim,
      expiresAt: '2026-09-19T12:11:00.000Z',
    },
    claim,
  );
  b.sys(
    1100,
    {
      type: 'COLLISION',
      collisionId: 'col-1',
      tier: 'PREDICTED',
      symbols: [USER_ID],
      writerSession: 'backend',
      affectedSessions: ['payments'],
      detail: 'Backend intends to change User.id; Payments has read user.ts and checkout.ts.',
      confidence: 0.86,
    },
    intent,
  );

  // Tier 2: the edit lands and the API delta names the break.
  b.agent(2000, 'backend', 'hook', { type: 'FILE_WRITE', path: USER, worktree: 'backend' });
  const delta = b.agent(2100, 'backend', 'watcher', {
    type: 'API_DELTA',
    module: USER,
    changes: [
      {
        symbol: USER_ID,
        before: 'number',
        after: 'string',
        breaking: true,
        reason: 'property type changed',
      },
    ],
  });
  b.sys(
    2200,
    {
      type: 'COLLISION',
      collisionId: 'col-1',
      tier: 'SEMANTIC',
      symbols: [USER_ID],
      writerSession: 'backend',
      affectedSessions: ['payments'],
      detail: 'User.id changed number -> string (breaking).',
    },
    delta,
  );
  // Tier 3: the speculative merge confirms it.
  b.sys(
    2500,
    {
      type: 'SPEC_MERGE_RESULT',
      baseCommit: 'a1b2c3d',
      sessions: ['backend', 'payments'],
      typeErrors: [
        {
          file: CHECKOUT,
          line: 14,
          code: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
        },
        {
          file: CHECKOUT,
          line: 31,
          code: 'TS2345',
          message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
        },
        {
          file: CHECKOUT,
          line: 58,
          code: 'TS2367',
          message: 'This comparison appears to be unintentional.',
        },
      ],
      failingTests: [],
      notRun: [],
    },
    delta,
  );

  // Lease enforcement: Payments tries to touch the leased symbol.
  const attempt = b.agent(3000, 'payments', 'hook', {
    type: 'LEASE_REQUESTED',
    symbols: [USER_ID],
    ttlMs: 600_000,
  });
  b.sys(
    3010,
    {
      type: 'LEASE_DENIED',
      symbols: [USER_ID],
      heldBy: 'backend',
      leaseId: 'lease-1',
      reason: 'symbol is leased by backend',
    },
    attempt,
  );

  // Dashboard-only: the prediction league opens on the collision. Agents must never see these.
  b.sys(3100, {
    type: 'MARKET_OPENED',
    marketId: 'mkt-1',
    kind: 'binary',
    question: 'Will the User.id negotiation settle without escalation?',
    outcomes: ['yes', 'no'],
    b: 100,
    closesAt: '2026-09-19T12:10:00.000Z',
    subjectSession: 'backend',
  });
  b.agent(3200, 'frontend', 'hook', { type: 'FILE_READ', path: 'src/ui/profile.tsx' });
  b.sys(3300, {
    type: 'TRADE',
    marketId: 'mkt-1',
    memberId: 'eng-payments',
    outcome: 'yes',
    shares: 20,
  });

  // Negotiation: message, proposal, accept, compile.
  b.agent(3500, 'payments', 'mcp', {
    type: 'MESSAGE',
    to: 'backend',
    text: 'checkout.ts passes user.id to numeric APIs. What is the target type?',
    collisionId: 'col-1',
  });
  const proposal = b.agent(4000, 'backend', 'mcp', {
    type: 'PROPOSAL',
    collisionId: 'col-1',
    contract,
  });
  const accept = b.agent(
    4300,
    'payments',
    'mcp',
    { type: 'ACCEPT', collisionId: 'col-1' },
    proposal,
  );
  b.sys(
    4500,
    {
      type: 'CONTRACT_COMPILED',
      contractId: 'contract-1',
      collisionId: 'col-1',
      checkFiles: [
        {
          path: 'contracts/user-id.test-d.ts',
          content: "expectTypeOf<User['id']>().toEqualTypeOf<string>();",
        },
      ],
    },
    accept,
  );
  b.sys(4600, {
    type: 'PERSONA_LINES',
    lines: [
      { speaker: 'BACKEND', text: 'Changed User.id to a UUID string.', seq: delta },
      { speaker: 'PAYMENTS', text: 'I was literally using that as a number.', seq: delta },
    ],
  });

  // Verify.
  b.agent(5000, 'backend', 'mcp', { type: 'LEASE_RELEASED', leaseId: 'lease-1' });
  b.sys(5500, {
    type: 'SPEC_MERGE_RESULT',
    baseCommit: 'a1b2c3d',
    sessions: ['backend', 'payments'],
    typeErrors: [],
    failingTests: [],
    notRun: [],
  });
  const result = b.sys(5600, { type: 'CONTRACT_RESULT', contractId: 'contract-1', status: 'pass' });
  b.sys(
    5700,
    { type: 'RUN_VERIFIED', runId: 'run-backend-1', sessionId: 'backend', durationMs: 5700 },
    result,
  );
  b.sys(5800, {
    type: 'MARKET_RESOLVED',
    marketId: 'mkt-1',
    outcome: 'yes',
    resolutionSeq: result,
  });
  return b.steps;
}

/** Marker: `TYPE` or `COLLISION:TIER`. */
const markerOf = (e: { payload: Payload }): string =>
  e.payload.type === 'COLLISION' ? `COLLISION:${e.payload.tier}` : e.payload.type;

const expectedOrder = [
  'SESSION_STARTED',
  'INTENT',
  'COLLISION:PREDICTED',
  'API_DELTA',
  'COLLISION:SEMANTIC',
  'SPEC_MERGE_RESULT',
  'LEASE_DENIED',
  'PROPOSAL',
  'ACCEPT',
  'CONTRACT_COMPILED',
  'RUN_VERIFIED',
];

export const userIdUuid: Scenario = {
  name: 'user-id-uuid',
  description: 'Backend migrates User.id number -> UUID string; Payments depends on it.',
  sessions,
  steps: build(),
  assertions: [
    {
      name: 'milestones occur in order (PREDICTED before SEMANTIC ... verified run)',
      check: ({ events }) => {
        let at = 0;
        for (const e of events) if (markerOf(e) === expectedOrder[at]) at++;
        return at === expectedOrder.length;
      },
    },
    {
      name: 'four sessions, all active, with distinct models',
      check: ({ state }) => {
        const s = Object.values(state.sessions);
        return (
          s.length === 4 &&
          s.every((x) => x.status === 'active') &&
          new Set(s.map((x) => x.model)).size === 4
        );
      },
    },
    {
      name: 'the announced intent is stored on Backend',
      check: ({ state }) => state.sessions.backend?.intent?.symbols.includes(USER_ID) ?? false,
    },
    {
      name: 'dashboard-only events are present (so routing tests have teeth)',
      check: ({ events }) => events.some((e) => !isAgentVisible(e.payload.type)),
    },
    {
      name: 'the fencing token equals the seq of the lease request',
      check: ({ events }) => {
        const granted = events.find((e) => e.payload.type === 'LEASE_GRANTED');
        return (
          granted?.payload.type === 'LEASE_GRANTED' &&
          granted.payload.fencingToken === granted.causedBy
        );
      },
    },
  ],
};
