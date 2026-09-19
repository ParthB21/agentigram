'use client';

import { brierScore, createMarket, quote, trade } from '@agentigram/league';
import type { MarketState } from '@agentigram/protocol';
import { useMemo, useState } from 'react';
import { marketRows } from '../lib/demo-data';

const seededMarket: MarketState = {
  ...createMarket({
    marketId: 'collision-settle',
    kind: 'binary',
    question: marketRows[0]?.question ?? 'Will this collision settle without escalation?',
    outcomes: ['Yes', 'No'],
    b: 100,
    closesAt: '2026-09-19T15:00:00Z',
    subjectSession: 'backend',
  }),
  shares: { Yes: 94.4, No: 0 },
};

export function LeagueView() {
  const [market, setMarket] = useState(seededMarket);
  const [outcome, setOutcome] = useState('Yes');
  const [shares, setShares] = useState(10);
  const [points, setPoints] = useState(982.4);
  const [notice, setNotice] = useState('');
  const preview = useMemo(() => trade(market, 'you', outcome, shares), [market, outcome, shares]);
  const currentProbability = quote(market, outcome);
  const resultingProbability = quote(preview.market, outcome);

  const confirm = () => {
    if (preview.cost > points) {
      setNotice('This trade costs more points than you have.');
      return;
    }
    setMarket(preview.market);
    setPoints((value) => value - preview.cost);
    setNotice(`Bought ${shares} ${outcome} shares for ${preview.cost.toFixed(1)} points.`);
  };

  return (
    <div className="page league-page">
      <header className="page-header">
        <div>
          <p className="context-line">Prediction league</p>
          <h1>Forecast the room. Learn from the miss.</h1>
          <p>Play points only. No purchases, transfers, prizes, or cash value.</p>
        </div>
        <span className="seed-label">Seeded rehearsal data</span>
      </header>
      <div className="league-grid">
        <section className="market-panel">
          <div className="section-heading">
            <h2>Open markets</h2>
            <span>2 open</span>
          </div>
          <article className="market active">
            <span className="market-kind">Collision</span>
            <h3>{market.question}</h3>
            <div className="market-probabilities">
              <strong>
                {Math.round(quote(market, 'Yes') * 100)}%<small>Yes</small>
              </strong>
              <strong>
                {Math.round(quote(market, 'No') * 100)}%<small>No</small>
              </strong>
            </div>
            <div className="probability-bar">
              <i style={{ width: `${quote(market, 'Yes') * 100}%` }}></i>
            </div>
            <p>Closes on contract verification</p>
          </article>
          <article className="market">
            <span className="market-kind">Duel</span>
            <h3>{marketRows[1]?.question ?? 'Who wins the duel?'}</h3>
            <div className="market-probabilities">
              <strong>
                58%<small>Opus</small>
              </strong>
              <strong>
                42%<small>GPT-5.4</small>
              </strong>
            </div>
            <div className="probability-bar duel">
              <i></i>
            </div>
            <p>Closes in 18 minutes</p>
          </article>
        </section>
        <section className="trade-panel">
          <div className="trade-balance">
            <span>Your balance</span>
            <strong>{points.toFixed(1)} pts</strong>
          </div>
          <h2>Trade this market</h2>
          <fieldset className="outcome-choice">
            <legend>Choose outcome</legend>
            {market.outcomes.map((name) => (
              <button
                className={outcome === name ? 'selected' : ''}
                key={name}
                onClick={() => setOutcome(name)}
                type="button"
              >
                <strong>{name}</strong>
                <span>{Math.round(quote(market, name) * 100)}%</span>
              </button>
            ))}
          </fieldset>
          <label htmlFor="shares">
            Shares <strong>{shares}</strong>
          </label>
          <input
            id="shares"
            max="50"
            min="1"
            onChange={(event) => setShares(Number(event.target.value))}
            type="range"
            value={shares}
          />
          <dl className="trade-preview">
            <div>
              <dt>Current price</dt>
              <dd>{Math.round(currentProbability * 100)}%</dd>
            </div>
            <div>
              <dt>After trade</dt>
              <dd>{Math.round(resultingProbability * 100)}%</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{preview.cost.toFixed(1)} pts</dd>
            </div>
          </dl>
          <button className="confirm-trade" onClick={confirm} type="button">
            Confirm trade
          </button>
          {notice && (
            <p className="action-notice" role="status">
              {notice}
            </p>
          )}
          <p className="integrity-note">
            Positions on your own agent are flagged. Human intervention after close voids that
            position and refunds it.
          </p>
        </section>
      </div>
      <div className="league-lower">
        <section>
          <div className="section-heading">
            <h2>Points leaderboard</h2>
            <span>season 01</span>
          </div>
          {[
            ['Jules', '1,184'],
            ['Rin', '1,097'],
            ['Maya', '1,028'],
            ['Sam', '982'],
          ].map(([name, score], index) => (
            <div className="leader-row" key={name}>
              <b>{index + 1}</b>
              <span>{name}</span>
              <strong>{score}</strong>
            </div>
          ))}
        </section>
        <section>
          <div className="section-heading">
            <h2>Calibration</h2>
            <span>lower is better</span>
          </div>
          <div className="calibration-score">
            <strong>{brierScore({ yes: 0.72, no: 0.28 }, 'yes').toFixed(3)}</strong>
            <span>
              Crowd Brier score<small>Router 0.181 · n=14</small>
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
