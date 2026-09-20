import { MAX_AUTOMATION_DEPTH, type Payload, symbolKey } from '@agentigram/protocol';
import type { Scenario, ScenarioSession, ScenarioStep } from '../scenario.js';

/**
 * The orchestrator allocating a room's work before anyone collides.
 *
 * Nobody announces anything here. Payments reads `user.ts` and `checkout.ts`, Backend edits
 * `user.ts`, and that is all the room is told — which on its own is only a tier-0 overlap, not
 * worth stopping anyone for. The orchestrator reads the room, gives each file one owner, speaks
 * the intent Backend never declared, takes the lease behind it and briefs each agent on what it
 * must not touch. Payments then asks for the file it was told to leave alone and is denied, and
 * the intent the orchestrator announced is what makes Backend's change a tier-1 `PREDICTED`
 * collision rather than a shrug.
 *
 * It is the same room as `user-id-uuid`, one step earlier: that scenario starts after someone has
 * already declared an intent, and this one shows where the intent came from.
 */

const USER = 'src/types/user.ts';
const CHECKOUT = 'src/checkout/checkout.ts';
const PROFILE = 'src/ui/profile.tsx';
export const USER_ID = symbolKey(USER, 'User', 'id', 'property');
const USER_TYPE = symbolKey(USER, 'User', 'interface');

export const sessions: ScenarioSession[] = [
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
    sessionId: 'frontend',
    engineerId: 'eng-frontend',
    role: 'Frontend',
    model: 'gemini-3-pro',
    host: 'gemini-cli',
    branch: 'p/frontend',
  },
];

const system = { engineerId: 'authority', kind: 'system' } as const;

const contract = {
  symbol: 'src/types/user.ts#User.id',
  kind: 'type',
  before: 'number',
  after: 'string',
  constraint: 'UUID v4',
  migration: 'checkout.ts keeps reading the old shape until it has migrated.',
} as const;

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
        id: `orchestrator-plan-${n}`,
        roomId: 'sim',
        actor,
        source,
        payload,
        ...(causedBy ? { causedBy } : {}),
      },
    });
    return n;
  }

  agent(atMs: number, sessionId: string, source: 'hook' | 'watcher' | 'mcp', payload: Payload) {
    const session = sessions.find((one) => one.sessionId === sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return this.add(atMs, { engineerId: session.engineerId, sessionId, kind: 'agent' }, source, payload);
  }

  /** The orchestrator speaking for an agent: the agent's actor, but the room's voice. */
  forAgent(atMs: number, sessionId: string, payload: Payload, causedBy?: number) {
    const session = sessions.find((one) => one.sessionId === sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return this.add(
      atMs,
      { engineerId: session.engineerId, sessionId, kind: 'agent' },
      'system',
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
  sessions.forEach((session, index) => {
    b.agent(index * 120, session.sessionId, 'hook', {
      type: 'SESSION_STARTED',
      sessionId: session.sessionId,
      host: session.host,
      model: session.model,
      branch: session.branch,
      role: session.role,
    });
  });

  // Ordinary work. Nobody has said what they are doing.
  b.agent(600, 'payments', 'hook', { type: 'FILE_READ', path: USER, symbols: [USER_ID, USER_TYPE] });
  b.agent(700, 'payments', 'hook', { type: 'FILE_READ', path: CHECKOUT });
  b.agent(800, 'frontend', 'hook', { type: 'FILE_READ', path: PROFILE });
  const blindWrite = b.agent(900, 'backend', 'hook', {
    type: 'FILE_WRITE',
    path: USER,
    worktree: 'backend',
  });
  // All the room can say without an intent: two agents, one file.
  b.sys(
    1000,
    {
      type: 'COLLISION',
      collisionId: 'overlap-1',
      tier: 'FILE_OVERLAP',
      symbols: [],
      writerSession: 'backend',
      affectedSessions: ['payments'],
      detail: 'backend is writing user.ts; payments has the same file open.',
      confidence: 0.4,
    },
    blindWrite,
  );

  // The orchestrator allocates the room.
  b.sys(1600, {
    type: 'MESSAGE',
    to: 'all',
    text: 'Orchestrator: 3 agents in the room. user.ts is wanted by 2 of them; backend keeps it and the others work around it.',
    conversationId: 'orchestrator:plan',
    automationDepth: MAX_AUTOMATION_DEPTH,
  });
  const intent = b.forAgent(2000, 'backend', {
    type: 'INTENT',
    task: 'Changing user.ts.',
    files: [USER],
    symbols: [USER_ID, USER_TYPE],
  });
  // The intent the orchestrator spoke is what raises the tier.
  b.sys(
    2100,
    {
      type: 'COLLISION',
      collisionId: 'col-1',
      tier: 'PREDICTED',
      symbols: [USER_ID],
      writerSession: 'backend',
      affectedSessions: ['payments'],
      detail: 'backend is changing User.id; payments has already read it.',
      confidence: 0.8,
    },
    intent,
  );
  const claim = b.forAgent(
    2200,
    'backend',
    { type: 'LEASE_REQUESTED', symbols: [USER_ID], ttlMs: 600_000 },
    intent,
  );
  b.sys(
    2260,
    {
      type: 'LEASE_GRANTED',
      leaseId: 'sim:plan-1',
      sessionId: 'backend',
      symbols: [USER_ID],
      fencingToken: claim,
      expiresAt: '2026-09-19T12:10:00.000Z',
      ttlMs: 600_000,
    },
    claim,
  );
  b.forAgent(2320, 'payments', {
    type: 'INTENT',
    task: 'Working through checkout.ts.',
    files: [CHECKOUT],
    symbols: [],
  });

  // Each agent is told its own half of the plan, at a depth that wakes a managed runner.
  b.sys(2600, {
    type: 'MESSAGE',
    to: 'backend',
    text: 'Your task: Changing user.ts. You own, and are the only one who may edit: src/types/user.ts.',
    conversationId: 'orchestrator:plan:backend',
    automationDepth: 0,
  });
  b.sys(2700, {
    type: 'MESSAGE',
    to: 'payments',
    text: 'Your task: Working through checkout.ts. Do not edit src/types/user.ts — backend owns it. Message backend if you need it changed.',
    conversationId: 'orchestrator:plan:payments',
    automationDepth: 0,
  });
  b.sys(2800, {
    type: 'MESSAGE',
    to: 'frontend',
    text: 'Your task: Working through profile.tsx. You own, and are the only one who may edit: src/ui/profile.tsx.',
    conversationId: 'orchestrator:plan:frontend',
    automationDepth: 0,
  });

  // Payments asks for the file it was told to leave alone.
  const attempt = b.agent(3200, 'payments', 'mcp', {
    type: 'LEASE_REQUESTED',
    symbols: [USER_ID],
    ttlMs: 600_000,
  });
  b.sys(
    3260,
    {
      type: 'LEASE_DENIED',
      symbols: [USER_ID],
      heldBy: 'backend',
      leaseId: 'sim:plan-1',
      reason: 'one or more symbols are already leased',
    },
    attempt,
  );

  // The collision the plan did not prevent is negotiated, in the room's voice as usual.
  b.forAgent(3800, 'backend', {
    type: 'MESSAGE',
    to: 'payments',
    text: 'I need User.id to be a UUID string for the migration. checkout.ts reads it as a number.',
    collisionId: 'col-1',
    conversationId: 'orchestrator:col-1',
    automationDepth: MAX_AUTOMATION_DEPTH,
  });
  const proposal = b.forAgent(4200, 'backend', {
    type: 'PROPOSAL',
    collisionId: 'col-1',
    contract,
  });
  b.forAgent(
    4600,
    'payments',
    {
      type: 'COUNTER',
      collisionId: 'col-1',
      contract,
      reason: 'I can accept that if the old shape stays readable until checkout.ts has moved.',
    },
    proposal,
  );
  const accept = b.forAgent(5000, 'backend', { type: 'ACCEPT', collisionId: 'col-1' });
  b.forAgent(5100, 'payments', { type: 'ACCEPT', collisionId: 'col-1' }, accept);
  b.sys(
    5400,
    {
      type: 'CONTRACT_COMPILED',
      contractId: 'contract-plan-1',
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
  b.sys(5600, {
    type: 'MESSAGE',
    to: 'all',
    text: 'Resolved: src/types/user.ts#User.id changes from number to string. backend and payments may resume; the contract check is contract-plan-1.',
    collisionId: 'col-1',
    conversationId: 'orchestrator:col-1',
    automationDepth: 0,
  });
  return b.steps;
}

const markerOf = (event: { payload: Payload }): string =>
  event.payload.type === 'COLLISION' ? `COLLISION:${event.payload.tier}` : event.payload.type;

const expectedOrder = [
  'SESSION_STARTED',
  'FILE_READ',
  'FILE_WRITE',
  'COLLISION:FILE_OVERLAP',
  'MESSAGE',
  'INTENT',
  'COLLISION:PREDICTED',
  'LEASE_GRANTED',
  'LEASE_DENIED',
  'PROPOSAL',
  'ACCEPT',
  'CONTRACT_COMPILED',
];

export const orchestratorPlan: Scenario = {
  name: 'orchestrator-plan',
  description:
    'Nobody declares anything; the orchestrator allocates the room, leases the contested file and briefs each agent.',
  sessions,
  steps: build(),
  assertions: [
    {
      name: 'the overlap is seen before the plan, and the plan before the tier-1 collision',
      check: ({ events }) => {
        let at = 0;
        for (const event of events) if (markerOf(event) === expectedOrder[at]) at++;
        return at === expectedOrder.length;
      },
    },
    {
      name: 'the orchestrator speaks an intent the agent never declared',
      check: ({ events }) =>
        events.some(
          (event) =>
            event.payload.type === 'INTENT' &&
            event.source === 'system' &&
            event.actor.sessionId === 'backend',
        ),
    },
    {
      name: 'the contested file ends up leased to exactly one session',
      check: ({ state }) => {
        const leases = Object.values(state.leases);
        return leases.length === 1 && leases[0]?.sessionId === 'backend';
      },
    },
    {
      name: 'every session is told what it is working on',
      check: ({ state }) =>
        Object.values(state.sessions).filter((session) => session.intent?.task).length >= 2,
    },
    {
      name: 'each agent gets a brief it can act on, and the announcement wakes nobody',
      check: ({ events }) => {
        const messages = events.filter((event) => event.payload.type === 'MESSAGE');
        const broadcast = messages.find(
          (event) => event.payload.type === 'MESSAGE' && event.payload.to === 'all',
        );
        const directed = messages.filter(
          (event) =>
            event.payload.type === 'MESSAGE' &&
            event.payload.to !== 'all' &&
            event.payload.automationDepth === 0,
        );
        return (
          broadcast?.payload.type === 'MESSAGE' &&
          broadcast.payload.automationDepth === MAX_AUTOMATION_DEPTH &&
          directed.length === 3
        );
      },
    },
    {
      name: 'the negotiation settles and the contract is compiled',
      check: ({ state }) =>
        state.negotiations['col-1']?.state === 'Compiled' &&
        Object.values(state.contracts).some((entry) => entry.collisionId === 'col-1'),
    },
  ],
};
