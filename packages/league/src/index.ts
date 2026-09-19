import { type MarketState, NotImplementedError } from '@clankergram/protocol';

export type MarketSpec = {
  marketId: string;
  kind: MarketState['kind'];
  question: string;
  outcomes: string[];
  /** LMSR liquidity; default 100 points. */
  b?: number;
  closesAt: string;
  subjectSession?: string;
};

export type TradeResult = { market: MarketState; cost: number };

/** LMSR: C(q) = b·ln(Σ exp(q_i/b)); all of these are pure functions of their arguments. */
export function createMarket(_spec: MarketSpec): MarketState {
  throw new NotImplementedError('league.createMarket (Part 4)');
}

/** Current price (= probability) of an outcome. Prices sum to 1. */
export function quote(_market: MarketState, _outcome: string): number {
  throw new NotImplementedError('league.quote (Part 4)');
}

export function trade(
  _market: MarketState,
  _memberId: string,
  _outcome: string,
  _shares: number,
): TradeResult {
  throw new NotImplementedError('league.trade (Part 4)');
}

export function resolve(
  _market: MarketState,
  _outcome: string,
  _resolutionSeq: number,
): MarketState {
  throw new NotImplementedError('league.resolve (Part 4)');
}

export function voidMarket(_market: MarketState, _reason: string): MarketState {
  throw new NotImplementedError('league.voidMarket (Part 4)');
}
