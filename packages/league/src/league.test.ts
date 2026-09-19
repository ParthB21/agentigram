import { describe, expect, it } from 'vitest';
import {
  applyVerificationEvent,
  brierScore,
  closeLeagueMarket,
  createLeague,
  createMarket,
  lmsrCost,
  placeTrade,
  prices,
  quote,
  settleMarket,
  voidAndRefund,
  voidFlaggedPosition,
} from './index.js';

const market = () =>
  createMarket({
    marketId: 'ci',
    kind: 'binary',
    question: 'Will CI pass?',
    outcomes: ['yes', 'no'],
    closesAt: '2026-09-19T12:00:00Z',
  });

describe('@clankergram/league', () => {
  it('creates an even market whose prices sum to one', () => {
    const current = market();
    expect(quote(current, 'yes')).toBeCloseTo(0.5);
    expect(Object.values(prices(current)).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it('raises the purchased outcome price and is path independent', () => {
    const initial = market();
    const oneStep = placeTrade(createLeague(['sam'], [initial]), 'sam', 'ci', 'yes', 20);
    const first = placeTrade(createLeague(['sam'], [initial]), 'sam', 'ci', 'yes', 8);
    const twoSteps = placeTrade(first, 'sam', 'ci', 'yes', 12);
    expect(quote(oneStep.markets.ci ?? initial, 'yes')).toBeGreaterThan(0.5);
    expect(oneStep.balances.sam ?? 0).toBeCloseTo(twoSteps.balances.sam ?? 0, 10);
    expect(lmsrCost([20, 0], 100) - lmsrCost([0, 0], 100)).toBeCloseTo(
      1_000 - (oneStep.balances.sam ?? 0),
    );
  });

  it('limits sales to holdings and pays the resolved outcome', () => {
    let book = placeTrade(createLeague(['sam'], [market()]), 'sam', 'ci', 'yes', 10);
    expect(() => placeTrade(book, 'sam', 'ci', 'yes', -11)).toThrow(/owns/);
    const spentBalance = book.balances.sam ?? 0;
    book = settleMarket(book, 'ci', 'yes', 42);
    expect(book.balances.sam ?? 0).toBeCloseTo(spentBalance + 10);
  });

  it('refunds every cash flow when voided', () => {
    let book = placeTrade(createLeague(['sam'], [market()]), 'sam', 'ci', 'yes', 12);
    book = placeTrade(book, 'sam', 'ci', 'yes', -4);
    expect(voidAndRefund(book, 'ci', 'intervention').balances.sam ?? 0).toBeCloseTo(1_000);
  });

  it('scores calibrated forecasts', () => {
    expect(brierScore({ yes: 0.8, no: 0.2 }, 'yes')).toBeCloseTo(0.08);
  });

  it('settles CI markets from authoritative results and audits the sequence', () => {
    const ci = createMarket({
      marketId: 'ci-abc',
      kind: 'binary',
      question: 'CI?',
      outcomes: ['pass', 'fail'],
      closesAt: '2026-09-19T12:00:00Z',
    });
    const book = placeTrade(createLeague(['sam'], [ci]), 'sam', 'ci-abc', 'pass', 10);
    const event = {
      id: 'e',
      seq: 12,
      roomId: 'r',
      ts: '2026-09-19T12:00:00Z',
      actor: { engineerId: 'system', kind: 'system' as const },
      source: 'github' as const,
      payload: { type: 'CI_RESULT' as const, commit: 'abc', status: 'pass' as const },
    };
    const settled = applyVerificationEvent(book, event);
    expect(settled.markets['ci-abc']?.status).toBe('resolved');
    expect(settled.resolutions['ci-abc']).toEqual({ outcome: 'pass', seq: 12 });
  });

  it('flags and refunds only own-agent positions after intervention', () => {
    const own = createMarket({
      marketId: 'm',
      kind: 'binary',
      question: 'Finish?',
      outcomes: ['yes', 'no'],
      closesAt: 'x',
      subjectSession: 'agent-a',
    });
    let book = placeTrade(
      createLeague(['sam'], [own], { 'agent-a': 'sam' }),
      'sam',
      'm',
      'yes',
      10,
    );
    book = closeLeagueMarket(book, 'm');
    const refunded = voidFlaggedPosition(book, 'sam', 'm');
    expect(refunded.balances.sam).toBeCloseTo(1_000);
    expect(refunded.voidedPositions).toContain('sam:m');
  });
});
