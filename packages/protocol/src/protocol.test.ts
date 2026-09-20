import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema,
  ContractSchema,
  DASHBOARD_ONLY_TYPES,
  EventSchema,
  emptyRoomState,
  isAgentVisible,
  MCP_TOOL_NAMES,
  McpToolInputs,
  matchesEventPattern,
  mcpToolJsonSchemas,
  PAYLOAD_TYPES,
  type Payload,
  PayloadSchema,
  parseSymbolKey,
  RoomStateSchema,
  ServerMessageSchema,
  subscriptionMatches,
  symbolKey,
} from './index.js';

const sym = symbolKey('src/types/user.ts', 'User', 'id', 'property');
const contract = {
  symbol: 'src/types/user.ts#User.id',
  kind: 'type',
  before: 'number',
  after: 'string',
} as const;
const marketId = 'm1';

const samples: Record<Payload['type'], Payload> = {
  FILE_READ: { type: 'FILE_READ', path: 'src/a.ts', symbols: [sym] },
  FILE_WRITE: { type: 'FILE_WRITE', path: 'src/a.ts', worktree: '/w' },
  API_DELTA: {
    type: 'API_DELTA',
    module: 'src/types/user.ts',
    changes: [
      { symbol: sym, before: 'number', after: 'string', breaking: true, reason: 'narrowed' },
    ],
  },
  TOOL_CALL: { type: 'TOOL_CALL', tool: 'Edit', phase: 'pre', paths: ['a.ts'] },
  USAGE: { type: 'USAGE', model: 'm', inputTokens: 1, outputTokens: 2 },
  INTENT: { type: 'INTENT', task: 't', files: ['a.ts'], symbols: [sym] },
  DISCOVERY: { type: 'DISCOVERY', text: 'x' },
  BLOCKER: { type: 'BLOCKER', text: 'x' },
  BUG: { type: 'BUG', text: 'x' },
  MESSAGE: {
    type: 'MESSAGE',
    to: 'all',
    text: 'hi',
    conversationId: 'conversation-1',
    replyToSeq: 3,
    automationDepth: 2,
    automationTerminal: false,
  },
  COMPLETE_CLAIMED: { type: 'COMPLETE_CLAIMED', summary: 's' },
  LEASE_REQUESTED: { type: 'LEASE_REQUESTED', symbols: [sym], ttlMs: 600000 },
  LEASE_GRANTED: {
    type: 'LEASE_GRANTED',
    leaseId: 'l',
    symbols: [sym],
    fencingToken: 3,
    expiresAt: 'x',
  },
  LEASE_DENIED: { type: 'LEASE_DENIED', symbols: [sym], heldBy: 's', reason: 'leased' },
  LEASE_RELEASED: { type: 'LEASE_RELEASED', leaseId: 'l' },
  LEASE_EXPIRED: { type: 'LEASE_EXPIRED', leaseId: 'l', reason: 'ttl' },
  COLLISION: {
    type: 'COLLISION',
    collisionId: 'c',
    tier: 'PREDICTED',
    symbols: [sym],
    writerSession: 'a',
    affectedSessions: ['b'],
    detail: 'd',
  },
  PROPOSAL: { type: 'PROPOSAL', collisionId: 'c', contract },
  COUNTER: { type: 'COUNTER', collisionId: 'c', contract, reason: 'r' },
  ACCEPT: { type: 'ACCEPT', collisionId: 'c' },
  ESCALATE: { type: 'ESCALATE', collisionId: 'c', reason: 'r' },
  CONTRACT_COMPILED: {
    type: 'CONTRACT_COMPILED',
    contractId: 'k',
    checkFiles: [{ path: 'a.test-d.ts', content: 'x' }],
  },
  CONTEXT_PACKET: { type: 'CONTEXT_PACKET', kind: 'intent', body: 'b', symbols: [] },
  CONTEXT_QUERY: { type: 'CONTEXT_QUERY', queryId: 'q', toSession: 's', question: '?' },
  CONTEXT_ANSWER: {
    type: 'CONTEXT_ANSWER',
    queryId: 'q',
    answer: 'a',
    citations: [{ path: 'a.ts', line: 1 }],
  },
  SPEC_MERGE_RESULT: {
    type: 'SPEC_MERGE_RESULT',
    baseCommit: 'abc',
    sessions: ['a', 'b'],
    typeErrors: [{ file: 'checkout.ts', line: 4, message: 'string is not number' }],
    failingTests: [],
    notRun: [],
  },
  CI_RESULT: { type: 'CI_RESULT', commit: 'abc', status: 'pass' },
  REVIEW_RESULT: { type: 'REVIEW_RESULT', pr: 1, state: 'approved' },
  CONTRACT_RESULT: { type: 'CONTRACT_RESULT', contractId: 'k', status: 'pass' },
  RUN_VERIFIED: { type: 'RUN_VERIFIED', runId: 'r', sessionId: 's' },
  SESSION_STARTED: {
    type: 'SESSION_STARTED',
    sessionId: 's',
    host: 'claude-code',
    model: 'm',
    branch: 'b',
  },
  SESSION_ENDED: { type: 'SESSION_ENDED', sessionId: 's' },
  HEARTBEAT: { type: 'HEARTBEAT', sessionId: 's' },
  TASK_CREATED: { type: 'TASK_CREATED', taskId: 't', title: 'x' },
  DUEL_STARTED: { type: 'DUEL_STARTED', duelId: 'd', taskId: 't', sessions: ['a', 'b'] },
  DUEL_RESULT: { type: 'DUEL_RESULT', duelId: 'd', winnerSession: null, reason: 'tie' },
  MARKET_OPENED: {
    type: 'MARKET_OPENED',
    marketId,
    kind: 'binary',
    question: 'q',
    outcomes: ['yes', 'no'],
    b: 100,
    closesAt: 'x',
  },
  TRADE: { type: 'TRADE', marketId, memberId: 'u', outcome: 'yes', shares: 10 },
  MARKET_CLOSED: { type: 'MARKET_CLOSED', marketId },
  MARKET_RESOLVED: { type: 'MARKET_RESOLVED', marketId, outcome: 'yes', resolutionSeq: 9 },
  MARKET_VOIDED: { type: 'MARKET_VOIDED', marketId, reason: 'cancelled' },
  PERSONA_LINES: { type: 'PERSONA_LINES', lines: [{ speaker: 'BACKEND', text: 'hi', seq: 1 }] },
};

const envelope = (payload: Payload) => ({
  id: 'e1',
  seq: 1,
  roomId: 'r',
  ts: '2026-09-19T00:00:00.000Z',
  actor: { engineerId: 'eng', sessionId: 's', kind: 'agent' as const },
  source: 'hook' as const,
  payload,
});

describe('payload union', () => {
  it('has a sample for every declared payload type', () => {
    expect(Object.keys(samples).sort()).toEqual([...PAYLOAD_TYPES].sort());
    expect(PAYLOAD_TYPES).toHaveLength(42);
  });

  it.each(Object.entries(samples))('%s round-trips through the envelope', (_type, payload) => {
    const parsed = EventSchema.parse(JSON.parse(JSON.stringify(envelope(payload))));
    expect(parsed.payload).toEqual(payload);
  });

  it('rejects unknown payload types and missing fields', () => {
    expect(PayloadSchema.safeParse({ type: 'NOPE' }).success).toBe(false);
    expect(PayloadSchema.safeParse({ type: 'FILE_WRITE', path: 'a.ts' }).success).toBe(false);
    expect(
      PayloadSchema.safeParse({ type: 'LEASE_REQUESTED', symbols: ['bad key'], ttlMs: 1 }).success,
    ).toBe(false);
    expect(
      PayloadSchema.safeParse({ type: 'COLLISION', collisionId: 'c', tier: 'MAYBE' }).success,
    ).toBe(false);
    expect(ContractSchema.safeParse({ symbol: 's' }).success).toBe(false);
  });

  it('rejects an envelope with a bad actor kind', () => {
    const bad = { ...envelope(samples.HEARTBEAT), actor: { engineerId: 'e', kind: 'robot' } };
    expect(EventSchema.safeParse(bad).success).toBe(false);
  });

  it('bounds automated message depth', () => {
    expect(
      PayloadSchema.safeParse({ type: 'MESSAGE', to: 'backend', text: 'reply', automationDepth: 3 })
        .success,
    ).toBe(true);
    expect(
      PayloadSchema.safeParse({ type: 'MESSAGE', to: 'backend', text: 'reply', automationDepth: 4 })
        .success,
    ).toBe(false);
  });
});

describe('agent visibility', () => {
  it('hides MARKET_*, TRADE and PERSONA_LINES from agents', () => {
    for (const t of PAYLOAD_TYPES) {
      const dashboardOnly = t.startsWith('MARKET_') || t === 'TRADE' || t === 'PERSONA_LINES';
      expect(isAgentVisible(t)).toBe(!dashboardOnly);
    }
    expect(DASHBOARD_ONLY_TYPES).toHaveLength(6);
  });

  it('a wildcard agent subscription never matches dashboard-only events', () => {
    const agent = { subscriberId: 'a', patterns: ['*'], audience: 'agent' as const };
    const dash = { ...agent, audience: 'dashboard' as const };
    expect(subscriptionMatches(agent, 'TRADE')).toBe(false);
    expect(subscriptionMatches(agent, 'COLLISION')).toBe(true);
    expect(subscriptionMatches(dash, 'TRADE')).toBe(true);
  });
});

describe('event pattern matching (ported from OpenAgents)', () => {
  it('supports *, prefix* and exact', () => {
    expect(matchesEventPattern('*', 'ANY')).toBe(true);
    expect(matchesEventPattern('LEASE_*', 'LEASE_GRANTED')).toBe(true);
    expect(matchesEventPattern('LEASE_*', 'COLLISION')).toBe(false);
    expect(matchesEventPattern('COLLISION', 'COLLISION')).toBe(true);
    expect(matchesEventPattern('COLLISION', 'COLLISION_X')).toBe(false);
  });
});

describe('symbol keys', () => {
  it('builds and parses keys', () => {
    expect(sym).toBe('src/types/user.ts#User.id:property');
    expect(parseSymbolKey(sym)).toEqual({
      path: 'src/types/user.ts',
      exportName: 'User',
      member: 'id',
      kind: 'property',
    });
    expect(symbolKey('./src/x.ts', 'Foo', 'interface')).toBe('src/x.ts#Foo:interface');
    expect(parseSymbolKey('src/x.ts#Foo:interface').member).toBeUndefined();
  });

  it('rejects malformed input', () => {
    expect(() => parseSymbolKey('nope')).toThrow();
    expect(() => symbolKey('a.ts', 'A.B', 'class')).toThrow();
    expect(() => symbolKey('a#b.ts', 'A', 'class')).toThrow();
  });
});

describe('wire messages', () => {
  it('parses HELLO and SUBMIT, rejects garbage', () => {
    const hello = { type: 'HELLO', roomId: 'r', lastSeq: 0, client: 'daemon', token: 't' };
    expect(ClientMessageSchema.parse(hello).type).toBe('HELLO');
    expect(ClientMessageSchema.safeParse({ ...hello, client: 'toaster' }).success).toBe(false);
    const { seq: _s, ts: _t, ...newEvent } = envelope(samples.HEARTBEAT);
    expect(ClientMessageSchema.parse({ type: 'SUBMIT', event: newEvent }).type).toBe('SUBMIT');
    expect(
      ClientMessageSchema.safeParse({ type: 'SUBMIT', event: envelope(samples.HEARTBEAT) }).success,
    ).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'WHAT' }).success).toBe(false);
  });

  it('parses server messages', () => {
    const state = emptyRoomState('r');
    expect(RoomStateSchema.parse(state)).toEqual(state);
    expect(ServerMessageSchema.parse({ type: 'WELCOME', roomState: state, fromSeq: 0 }).type).toBe(
      'WELCOME',
    );
    expect(ServerMessageSchema.parse({ type: 'ACK', id: 'e', seq: 1 }).type).toBe('ACK');
    expect(
      ServerMessageSchema.parse({ type: 'ERROR', code: 'BAD_MESSAGE', message: 'm' }).type,
    ).toBe('ERROR');
    expect(
      ServerMessageSchema.safeParse({ type: 'ERROR', code: 'WEIRD', message: 'm' }).success,
    ).toBe(false);
  });
});

describe('MCP tool schemas', () => {
  it('exports JSON Schema for every tool', () => {
    const schemas = mcpToolJsonSchemas();
    expect(MCP_TOOL_NAMES).toEqual([
      'sync',
      'announce_intent',
      'report',
      'message_agent',
      'propose',
      'respond',
      'ask_context',
      'claim_complete',
    ]);
    for (const name of MCP_TOOL_NAMES) expect(schemas[name]?.type).toBe('object');
    expect(McpToolInputs.report.safeParse({ kind: 'gossip', text: 'x' }).success).toBe(false);
  });
});
