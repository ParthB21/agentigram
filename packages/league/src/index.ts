import type { Event, MarketState } from '@clankergram/protocol';

const DEFAULT_LIQUIDITY = 100;
export const STARTING_POINTS = 1_000;
const DEFAULT_MARKET_DURATION_MS = 30 * 60 * 1_000;

export type MarketSpec = {
  marketId: string;
  kind: MarketState['kind'];
  question: string;
  outcomes: string[];
  b?: number;
  closesAt: string;
  subjectSession?: string;
};

export type TradeResult = { market: MarketState; cost: number };
export type TradeRecord = {
  marketId: string;
  memberId: string;
  outcome: string;
  shares: number;
  cost: number;
};
export type LeagueBook = {
  markets: Record<string, MarketState>;
  balances: Record<string, number>;
  holdings: Record<string, Record<string, Record<string, number>>>;
  trades: TradeRecord[];
  flaggedPositions: string[];
  voidedPositions: string[];
  owners: Record<string, string>;
  closingForecasts: Record<string, Record<string, Record<string, number>>>;
  resolutions: Record<string, { outcome: string; seq: number }>;
};

export class LeagueError extends Error {
  constructor(
    readonly code:
      | 'INVALID_MARKET'
      | 'MARKET_CLOSED'
      | 'UNKNOWN_OUTCOME'
      | 'INSUFFICIENT_POINTS'
      | 'INSUFFICIENT_HOLDINGS',
    message: string,
  ) {
    super(message);
    this.name = 'LeagueError';
  }
}

export function lmsrCost(shares: number[], liquidity: number): number {
  if (!(liquidity > 0) || shares.length < 2 || shares.some((value) => !Number.isFinite(value))) {
    throw new LeagueError('INVALID_MARKET', 'LMSR requires finite shares and positive liquidity');
  }
  const scaled = shares.map((value) => value / liquidity);
  const maximum = Math.max(...scaled);
  const logSum =
    maximum + Math.log(scaled.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
  return liquidity * logSum;
}

export function prices(market: MarketState): Record<string, number> {
  const scaled = market.outcomes.map((outcome) => (market.shares[outcome] ?? 0) / market.b);
  const maximum = Math.max(...scaled);
  const weights = scaled.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    market.outcomes.map((outcome, index) => [outcome, (weights[index] ?? 0) / total]),
  );
}

export function createMarket(spec: MarketSpec): MarketState {
  const outcomes = [...new Set(spec.outcomes.map((outcome) => outcome.trim()).filter(Boolean))];
  const liquidity = spec.b ?? DEFAULT_LIQUIDITY;
  if (!spec.marketId || !spec.question.trim() || outcomes.length < 2 || !(liquidity > 0)) {
    throw new LeagueError(
      'INVALID_MARKET',
      'A market needs an id, question, two outcomes, and positive liquidity',
    );
  }
  return {
    marketId: spec.marketId,
    kind: spec.kind,
    question: spec.question,
    outcomes,
    b: liquidity,
    closesAt: spec.closesAt,
    ...(spec.subjectSession ? { subjectSession: spec.subjectSession } : {}),
    status: 'open',
    shares: Object.fromEntries(outcomes.map((outcome) => [outcome, 0])),
  };
}

export function quote(market: MarketState, outcome: string): number {
  assertOutcome(market, outcome);
  return prices(market)[outcome] ?? 0;
}

export function trade(
  market: MarketState,
  _memberId: string,
  outcome: string,
  shareCount: number,
): TradeResult {
  if (market.status !== 'open') throw new LeagueError('MARKET_CLOSED', 'The market is not open');
  assertOutcome(market, outcome);
  if (!Number.isFinite(shareCount) || shareCount === 0) {
    throw new LeagueError('INVALID_MARKET', 'A trade must contain a finite, non-zero share count');
  }
  const before = market.outcomes.map((name) => market.shares[name] ?? 0);
  const nextShares = { ...market.shares, [outcome]: (market.shares[outcome] ?? 0) + shareCount };
  const after = market.outcomes.map((name) => nextShares[name] ?? 0);
  return {
    market: { ...market, shares: nextShares },
    cost: lmsrCost(after, market.b) - lmsrCost(before, market.b),
  };
}

export function resolve(market: MarketState, outcome: string, _resolutionSeq: number): MarketState {
  assertOutcome(market, outcome);
  if (market.status === 'void')
    throw new LeagueError('MARKET_CLOSED', 'A void market cannot resolve');
  return { ...market, status: 'resolved', resolvedOutcome: outcome };
}

export function closeMarket(market: MarketState): MarketState {
  if (market.status !== 'open') return market;
  return { ...market, status: 'closed' };
}

export function voidMarket(market: MarketState, _reason: string): MarketState {
  if (market.status === 'resolved') {
    throw new LeagueError('MARKET_CLOSED', 'A resolved market cannot be voided');
  }
  return { ...market, status: 'void' };
}

export function createLeague(
  memberIds: string[],
  markets: MarketState[] = [],
  owners: Record<string, string> = {},
): LeagueBook {
  return {
    markets: Object.fromEntries(markets.map((market) => [market.marketId, market])),
    balances: Object.fromEntries(memberIds.map((memberId) => [memberId, STARTING_POINTS])),
    holdings: {},
    trades: [],
    flaggedPositions: [],
    voidedPositions: [],
    owners: { ...owners },
    closingForecasts: {},
    resolutions: {},
  };
}

export function placeTrade(
  book: LeagueBook,
  memberId: string,
  marketId: string,
  outcome: string,
  shareCount: number,
): LeagueBook {
  const market = book.markets[marketId];
  if (!market) throw new LeagueError('INVALID_MARKET', `Unknown market: ${marketId}`);
  const current = book.holdings[memberId]?.[marketId]?.[outcome] ?? 0;
  if (shareCount < 0 && current + shareCount < -Number.EPSILON) {
    throw new LeagueError('INSUFFICIENT_HOLDINGS', 'Selling is limited to shares the member owns');
  }
  const result = trade(market, memberId, outcome, shareCount);
  const balance = book.balances[memberId] ?? STARTING_POINTS;
  if (result.cost > balance) {
    throw new LeagueError('INSUFFICIENT_POINTS', 'The trade costs more points than the member has');
  }
  const memberHoldings = book.holdings[memberId] ?? {};
  const marketHoldings = memberHoldings[marketId] ?? {};
  const flag =
    market.subjectSession &&
    (market.subjectSession === memberId || book.owners[market.subjectSession] === memberId)
      ? `${memberId}:${marketId}`
      : undefined;
  return {
    ...book,
    markets: { ...book.markets, [marketId]: result.market },
    balances: { ...book.balances, [memberId]: balance - result.cost },
    holdings: {
      ...book.holdings,
      [memberId]: {
        ...memberHoldings,
        [marketId]: { ...marketHoldings, [outcome]: current + shareCount },
      },
    },
    trades: [
      ...book.trades,
      { marketId, memberId, outcome, shares: shareCount, cost: result.cost },
    ],
    flaggedPositions: flag ? [...new Set([...book.flaggedPositions, flag])] : book.flaggedPositions,
  };
}

export function settleMarket(
  book: LeagueBook,
  marketId: string,
  outcome: string,
  resolutionSeq: number,
): LeagueBook {
  const market = book.markets[marketId];
  if (!market) throw new LeagueError('INVALID_MARKET', `Unknown market: ${marketId}`);
  const balances = { ...book.balances };
  for (const [memberId, holdings] of Object.entries(book.holdings)) {
    balances[memberId] =
      (balances[memberId] ?? STARTING_POINTS) + (holdings[marketId]?.[outcome] ?? 0);
  }
  return {
    ...book,
    balances,
    markets: { ...book.markets, [marketId]: resolve(market, outcome, resolutionSeq) },
    resolutions: { ...book.resolutions, [marketId]: { outcome, seq: resolutionSeq } },
  };
}

export function closeLeagueMarket(book: LeagueBook, marketId: string): LeagueBook {
  const market = book.markets[marketId];
  if (!market) throw new LeagueError('INVALID_MARKET', `Unknown market: ${marketId}`);
  const forecasts: Record<string, Record<string, number>> = {};
  for (const memberId of Object.keys(book.balances)) {
    const memberTrades = book.trades.filter(
      (trade) => trade.marketId === marketId && trade.memberId === memberId,
    );
    if (memberTrades.length > 0) forecasts[memberId] = prices(market);
  }
  return {
    ...book,
    markets: { ...book.markets, [marketId]: closeMarket(market) },
    closingForecasts: { ...book.closingForecasts, [marketId]: forecasts },
  };
}

/** Refund only a member's own-agent position after a post-close human intervention. */
export function voidFlaggedPosition(
  book: LeagueBook,
  memberId: string,
  marketId: string,
): LeagueBook {
  const key = `${memberId}:${marketId}`;
  if (!book.flaggedPositions.includes(key) || book.voidedPositions.includes(key)) return book;
  const refund = book.trades
    .filter((trade) => trade.marketId === marketId && trade.memberId === memberId)
    .reduce((sum, trade) => sum + trade.cost, 0);
  return {
    ...book,
    balances: {
      ...book.balances,
      [memberId]: (book.balances[memberId] ?? STARTING_POINTS) + refund,
    },
    holdings: {
      ...book.holdings,
      [memberId]: { ...(book.holdings[memberId] ?? {}), [marketId]: {} },
    },
    voidedPositions: [...book.voidedPositions, key],
  };
}

export function voidAndRefund(book: LeagueBook, marketId: string, reason: string): LeagueBook {
  const market = book.markets[marketId];
  if (!market) throw new LeagueError('INVALID_MARKET', `Unknown market: ${marketId}`);
  const balances = { ...book.balances };
  for (const record of book.trades.filter((entry) => entry.marketId === marketId)) {
    balances[record.memberId] = (balances[record.memberId] ?? STARTING_POINTS) + record.cost;
  }
  return {
    ...book,
    balances,
    markets: { ...book.markets, [marketId]: voidMarket(market, reason) },
  };
}

export function brierScore(forecast: Record<string, number>, resolvedOutcome: string): number {
  const outcomes = Object.keys(forecast);
  if (!outcomes.includes(resolvedOutcome)) {
    throw new LeagueError('UNKNOWN_OUTCOME', resolvedOutcome);
  }
  return outcomes.reduce(
    (score, outcome) =>
      score + ((forecast[outcome] ?? 0) - (outcome === resolvedOutcome ? 1 : 0)) ** 2,
    0,
  );
}

export function autoOpenMarkets(event: Event): MarketSpec[] {
  const closesAt = new Date(Date.parse(event.ts) + DEFAULT_MARKET_DURATION_MS).toISOString();
  switch (event.payload.type) {
    case 'SESSION_STARTED':
      return event.payload.task
        ? [
            {
              marketId: `time-${event.payload.sessionId}`,
              kind: 'range',
              question: `When will ${event.payload.role ?? 'this agent'} finish?`,
              outcomes: ['<15m', '15–30m', '>30m'],
              closesAt,
              subjectSession: event.payload.sessionId,
            },
          ]
        : [];
    case 'DUEL_STARTED':
      return [
        {
          marketId: `duel-${event.payload.duelId}`,
          kind: 'categorical',
          question: 'Which model wins the duel?',
          outcomes: [...event.payload.sessions],
          closesAt,
        },
      ];
    case 'COLLISION':
      return [
        {
          marketId: `collision-${event.payload.collisionId}`,
          kind: 'binary',
          question: 'Will this collision settle without escalation?',
          outcomes: ['yes', 'no'],
          closesAt,
          subjectSession: event.payload.writerSession,
        },
      ];
    default:
      return [];
  }
}

export function marketForPush(commit: string, at: string): MarketSpec {
  return {
    marketId: `ci-${commit}`,
    kind: 'binary',
    question: `Will CI pass for ${commit.slice(0, 8)}?`,
    outcomes: ['pass', 'fail'],
    closesAt: at,
  };
}

/** Pure automatic closing/settlement from authoritative verification events. */
export function applyVerificationEvent(book: LeagueBook, event: Event): LeagueBook {
  let next = closeDueMarkets(book, event.ts);
  const payload = event.payload;
  if (payload.type === 'CI_RESULT') {
    const id = `ci-${payload.commit}`;
    if (next.markets[id])
      next = settleMarket(closeLeagueMarket(next, id), id, payload.status, event.seq);
  } else if (payload.type === 'DUEL_RESULT') {
    const id = `duel-${payload.duelId}`;
    if (next.markets[id]) {
      next = payload.winnerSession
        ? settleMarket(closeLeagueMarket(next, id), id, payload.winnerSession, event.seq)
        : voidAndRefund(next, id, payload.reason);
    }
  } else if (payload.type === 'RUN_VERIFIED') {
    const id = `time-${payload.sessionId}`;
    const market = next.markets[id];
    if (market && payload.durationMs !== undefined) {
      const minutes = payload.durationMs / 60_000;
      const outcome = minutes < 15 ? '<15m' : minutes <= 30 ? '15â€“30m' : '>30m';
      next = settleMarket(closeLeagueMarket(next, id), id, outcome, event.seq);
    }
  }
  return next;
}

export function closeDueMarkets(book: LeagueBook, at: string): LeagueBook {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return book;
  let next = book;
  for (const market of Object.values(next.markets)) {
    if (market.status === 'open' && Date.parse(market.closesAt) <= timestamp)
      next = closeLeagueMarket(next, market.marketId);
  }
  return next;
}

export function calibrationLeaderboard(
  book: LeagueBook,
): Array<{ memberId: string; score: number; samples: number }> {
  return Object.keys(book.balances)
    .map((memberId) => {
      const scores = Object.entries(book.resolutions).flatMap(([marketId, resolution]) => {
        const forecast = book.closingForecasts[marketId]?.[memberId];
        return forecast ? [brierScore(forecast, resolution.outcome)] : [];
      });
      return {
        memberId,
        score: scores.length
          ? scores.reduce((sum, score) => sum + score, 0) / scores.length
          : Number.NaN,
        samples: scores.length,
      };
    })
    .sort(
      (a, b) =>
        (Number.isNaN(a.score) ? 1 : Number.isNaN(b.score) ? -1 : a.score - b.score) ||
        a.memberId.localeCompare(b.memberId),
    );
}

function assertOutcome(market: MarketState, outcome: string): void {
  if (!market.outcomes.includes(outcome)) {
    throw new LeagueError('UNKNOWN_OUTCOME', `Unknown outcome: ${outcome}`);
  }
}
