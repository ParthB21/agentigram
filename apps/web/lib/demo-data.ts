import type { Event, Payload } from '@clankergram/protocol';

export const USER_ID_SYMBOL = 'src/types/user.ts#User.id:property';

export type AgentDisplay = {
  id: string;
  engineer: string;
  role: string;
  model: string;
  host: string;
  branch: string;
  task: string;
  status: 'active' | 'blocked' | 'idle';
  lease?: string;
};

export const agents: AgentDisplay[] = [
  {
    id: 'backend',
    engineer: 'Maya',
    role: 'Backend',
    model: 'Claude Opus 5',
    host: 'Claude Code',
    branch: 'feature/user-uuid',
    task: 'Migrate user identifiers to UUID',
    status: 'active',
    lease: 'User.id',
  },
  {
    id: 'payments',
    engineer: 'Sam',
    role: 'Payments',
    model: 'GPT-5.4',
    host: 'Codex',
    branch: 'feature/checkout',
    task: 'Build authenticated checkout',
    status: 'blocked',
  },
  {
    id: 'frontend',
    engineer: 'Jules',
    role: 'Frontend',
    model: 'Gemini 3 Pro',
    host: 'Gemini CLI',
    branch: 'feature/checkout-ui',
    task: 'Connect checkout UI types',
    status: 'active',
  },
  {
    id: 'security',
    engineer: 'Rin',
    role: 'Security',
    model: 'Claude Sonnet 4.6',
    host: 'Claude Code',
    branch: 'review/auth-middleware',
    task: 'Review session boundaries',
    status: 'idle',
  },
];

export const activeCollision = {
  id: 'collision-user-id',
  tier: 'SEMANTIC',
  confidence: 0.96,
  symbol: USER_ID_SYMBOL,
  writer: 'Backend',
  affected: 'Payments',
  detail: 'User.id changed from number to string while checkout still passes it to a numeric API.',
  references: ['src/checkout/checkout.ts:31', 'src/checkout/stripe.ts:18'],
  typeErrors: [
    'checkout.ts:31 — string is not assignable to number',
    'stripe.ts:18 — customer metadata expects number',
  ],
  negotiation: ['Open', 'Proposed', 'Accepted', 'Compiled'],
};

export const contract = {
  id: 'contract-user-id-v1',
  symbol: 'src/types/user.ts#User.id',
  before: 'number',
  after: 'string',
  constraint: 'UUID v4',
  migration: 'All callers update before Backend releases its lease.',
  participants: ['Backend', 'Payments'],
  version: 1,
  status: 'compiled',
  check: '.clankergram/contracts/user-id-v1.ts',
};

export const modelRows = [
  {
    model: 'Claude Opus 5',
    category: 'Backend',
    successes: 10,
    failures: 2,
    medianMinutes: 18,
    cost: 4.2,
  },
  {
    model: 'GPT-5.4',
    category: 'Backend',
    successes: 7,
    failures: 3,
    medianMinutes: 21,
    cost: 3.1,
  },
  {
    model: 'Gemini 3 Pro',
    category: 'Frontend',
    successes: 5,
    failures: 3,
    medianMinutes: 16,
    cost: 2.2,
  },
  {
    model: 'Claude Sonnet 4.6',
    category: 'Security',
    successes: 3,
    failures: 2,
    medianMinutes: 14,
    cost: 1.7,
  },
];

export const duelRows = [
  { task: 'Fix stale session refresh', winner: 'Claude Opus 5', loser: 'GPT-5.4', duration: '11m' },
  { task: 'Repair checkout retry', winner: 'GPT-5.4', loser: 'Gemini 3 Pro', duration: '14m' },
  {
    task: 'Harden redirect validation',
    winner: 'Claude Sonnet 4.6',
    loser: 'GPT-5.4',
    duration: '9m',
  },
];

export const marketRows = [
  {
    id: 'collision-settle',
    question: 'Will the User.id collision settle without escalation?',
    outcomes: [
      { name: 'Yes', probability: 0.72 },
      { name: 'No', probability: 0.28 },
    ],
    closes: 'on contract verification',
  },
  {
    id: 'duel-checkout',
    question: 'Who wins the checkout retry duel?',
    outcomes: [
      { name: 'Claude Opus 5', probability: 0.58 },
      { name: 'GPT-5.4', probability: 0.42 },
    ],
    closes: 'in 18 minutes',
  },
];

const actors = {
  backend: { engineerId: 'maya', sessionId: 'backend', kind: 'agent' as const },
  payments: { engineerId: 'sam', sessionId: 'payments', kind: 'agent' as const },
  frontend: { engineerId: 'jules', sessionId: 'frontend', kind: 'agent' as const },
  security: { engineerId: 'rin', sessionId: 'security', kind: 'agent' as const },
  system: { engineerId: 'clankergram', kind: 'system' as const },
};

function event(
  seq: number,
  actor: keyof typeof actors,
  payload: Payload,
  source: Event['source'] = 'system',
): Event {
  return {
    id: `rehearsal-${seq}`,
    seq,
    roomId: 'hackathon',
    ts: new Date(Date.UTC(2026, 8, 19, 14, 30, seq * 2)).toISOString(),
    actor: actors[actor],
    source,
    payload,
  };
}

export const demoEvents: Event[] = [
  event(1, 'backend', {
    type: 'SESSION_STARTED',
    sessionId: 'backend',
    host: 'Claude Code',
    model: 'Claude Opus 5',
    branch: 'feature/user-uuid',
    role: 'Backend',
    task: 'Migrate user identifiers to UUID',
  }),
  event(2, 'payments', {
    type: 'SESSION_STARTED',
    sessionId: 'payments',
    host: 'Codex',
    model: 'GPT-5.4',
    branch: 'feature/checkout',
    role: 'Payments',
    task: 'Build authenticated checkout',
  }),
  event(3, 'frontend', {
    type: 'SESSION_STARTED',
    sessionId: 'frontend',
    host: 'Gemini CLI',
    model: 'Gemini 3 Pro',
    branch: 'feature/checkout-ui',
    role: 'Frontend',
    task: 'Connect checkout UI types',
  }),
  event(4, 'security', {
    type: 'SESSION_STARTED',
    sessionId: 'security',
    host: 'Claude Code',
    model: 'Claude Sonnet 4.6',
    branch: 'review/auth-middleware',
    role: 'Security',
    task: 'Review session boundaries',
  }),
  event(
    5,
    'payments',
    { type: 'FILE_READ', path: 'src/checkout/checkout.ts', symbols: [USER_ID_SYMBOL] },
    'hook',
  ),
  event(
    6,
    'backend',
    {
      type: 'INTENT',
      task: 'Change User.id from number to UUID string',
      files: ['src/types/user.ts'],
      symbols: [USER_ID_SYMBOL],
    },
    'mcp',
  ),
  event(7, 'backend', {
    type: 'COLLISION',
    collisionId: activeCollision.id,
    tier: 'PREDICTED',
    symbols: [USER_ID_SYMBOL],
    writerSession: 'backend',
    affectedSessions: ['payments'],
    detail: 'Payments read User.id three minutes ago.',
    confidence: 0.86,
  }),
  event(
    8,
    'backend',
    { type: 'FILE_WRITE', path: 'src/types/user.ts', worktree: '/repo/backend' },
    'watcher',
  ),
  event(
    9,
    'backend',
    {
      type: 'API_DELTA',
      module: 'src/types/user.ts',
      changes: [
        {
          symbol: USER_ID_SYMBOL,
          before: 'number',
          after: 'string',
          breaking: true,
          reason: 'Output property type changed incompatibly.',
        },
      ],
    },
    'watcher',
  ),
  event(10, 'backend', {
    type: 'COLLISION',
    collisionId: activeCollision.id,
    tier: 'SEMANTIC',
    symbols: [USER_ID_SYMBOL],
    writerSession: 'backend',
    affectedSessions: ['payments'],
    detail: activeCollision.detail,
    confidence: 0.96,
  }),
  event(
    11,
    'payments',
    {
      type: 'LEASE_DENIED',
      symbols: [USER_ID_SYMBOL],
      heldBy: 'backend',
      leaseId: 'lease-user-id',
      reason: 'Backend owns the active migration lease.',
    },
    'hook',
  ),
  event(
    12,
    'payments',
    {
      type: 'MESSAGE',
      to: 'backend',
      collisionId: activeCollision.id,
      text: 'Checkout reads User.id. Holding my write until we agree on the new type.',
    },
    'mcp',
  ),
  event(
    13,
    'backend',
    {
      type: 'PROPOSAL',
      collisionId: activeCollision.id,
      contract: {
        symbol: 'src/types/user.ts#User.id',
        kind: 'type',
        before: 'number',
        after: 'string',
        constraint: 'UUID v4',
        migration: contract.migration,
      },
    },
    'mcp',
  ),
  event(14, 'backend', { type: 'ACCEPT', collisionId: activeCollision.id }, 'mcp'),
  event(15, 'payments', { type: 'ACCEPT', collisionId: activeCollision.id }, 'mcp'),
  event(16, 'system', {
    type: 'CONTRACT_COMPILED',
    contractId: contract.id,
    collisionId: activeCollision.id,
    checkFiles: [
      { path: contract.check, content: "expectTypeOf<User['id']>().toEqualTypeOf<string>();" },
    ],
  }),
  event(17, 'system', {
    type: 'SPEC_MERGE_RESULT',
    baseCommit: '7d31be9',
    sessions: ['backend', 'payments'],
    typeErrors: [],
    failingTests: [],
    notRun: [],
  }),
  event(18, 'system', {
    type: 'CONTRACT_RESULT',
    contractId: contract.id,
    status: 'pass',
    detail: 'UUID type assertion passed.',
  }),
  event(19, 'system', {
    type: 'RUN_VERIFIED',
    runId: 'run-backend-14',
    sessionId: 'backend',
    durationMs: 1_080_000,
  }),
  event(20, 'system', {
    type: 'DUEL_STARTED',
    duelId: 'duel-checkout-retry',
    taskId: 'task-retry',
    sessions: ['backend', 'payments'],
  }),
  event(21, 'system', {
    type: 'MARKET_OPENED',
    marketId: 'duel-checkout',
    kind: 'binary',
    question: 'Who wins the checkout retry duel?',
    outcomes: ['Claude Opus 5', 'GPT-5.4'],
    b: 100,
    closesAt: '2026-09-19T15:30:00Z',
  }),
];

export function describeEvent(item: Event): string {
  const actor = item.actor.sessionId ?? item.actor.engineerId;
  switch (item.payload.type) {
    case 'SESSION_STARTED':
      return `${actor} joined on ${item.payload.model}`;
    case 'FILE_READ':
      return `${actor} read ${item.payload.path}`;
    case 'FILE_WRITE':
      return `${actor} changed ${item.payload.path}`;
    case 'INTENT':
      return `${actor} announced: ${item.payload.task}`;
    case 'COLLISION':
      return `${item.payload.tier.toLowerCase()} collision detected`;
    case 'MESSAGE':
      return `${actor}: ${item.payload.text}`;
    case 'PROPOSAL':
      return `${actor} proposed ${item.payload.contract.before} → ${item.payload.contract.after}`;
    case 'ACCEPT':
      return `${actor} accepted the contract`;
    case 'CONTRACT_COMPILED':
      return 'Contract check compiled';
    case 'SPEC_MERGE_RESULT':
      return item.payload.typeErrors.length === 0
        ? 'Speculative merge passed'
        : 'Speculative merge found errors';
    case 'CONTRACT_RESULT':
      return `Contract ${item.payload.status}`;
    case 'RUN_VERIFIED':
      return `${item.payload.sessionId} run verified`;
    default:
      return item.payload.type.toLowerCase().replaceAll('_', ' ');
  }
}
