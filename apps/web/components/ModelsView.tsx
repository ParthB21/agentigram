import {
  betaPosterior,
  bradleyTerry,
  posteriorSummary,
  seededRandom,
  thompsonRecommendation,
} from '@clankergram/stats';
import { duelRows, modelRows } from '../lib/demo-data';

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function ModelsView() {
  const summaries = modelRows.map((row, index) => ({
    ...row,
    summary: posteriorSummary(
      betaPosterior(row.successes, row.failures),
      row.successes + row.failures,
      seededRandom(100 + index),
      2_000,
    ),
  }));
  const ratings = bradleyTerry(
    duelRows.map((duel) => ({ winner: duel.winner, loser: duel.loser })),
  );
  const recommendation = thompsonRecommendation(
    modelRows
      .filter((row) => row.category === 'Backend')
      .map((row) => ({
        model: row.model,
        posterior: betaPosterior(row.successes, row.failures),
        cost: row.cost,
        sampleSize: row.successes + row.failures,
      })),
    { lambda: 0.16, budget: 6, rng: seededRandom(44) },
  );
  return (
    <div className="page models-page">
      <header className="page-header">
        <div>
          <p className="context-line">Model intelligence</p>
          <h1>Evidence, with uncertainty attached.</h1>
          <p>Verified outcomes from this team—not a generic benchmark.</p>
        </div>
        <span className="seed-label">Seeded rehearsal data</span>
      </header>
      <section className="router-callout">
        <div>
          <span>Recommended for backend work</span>
          <h2>{recommendation.model}</h2>
          <p>{recommendation.reason}. Thompson sampling keeps under-tested models in rotation.</p>
        </div>
        <strong>
          {recommendation.score.toFixed(2)}
          <small>sampled score</small>
        </strong>
      </section>
      <section className="model-table" aria-label="Model performance by category">
        <div className="model-table-head">
          <span>Model</span>
          <span>Category</span>
          <span>Verified success, 80% interval</span>
          <span>Median</span>
          <span>n</span>
        </div>
        {summaries.map((row) => (
          <article className="model-row" key={`${row.model}-${row.category}`}>
            <strong>{row.model}</strong>
            <span>{row.category}</span>
            <div className="interval">
              <i
                style={{
                  left: percent(row.summary.lower),
                  width: percent(row.summary.upper - row.summary.lower),
                }}
              ></i>
              <b style={{ left: percent(row.summary.median) }}></b>
              <span>
                {percent(row.summary.lower)}–{percent(row.summary.upper)}
              </span>
            </div>
            <strong>{percent(row.summary.median)}</strong>
            <span>{row.summary.sampleSize}</span>
          </article>
        ))}
      </section>
      <div className="models-lower">
        <section className="duel-panel">
          <div className="section-heading">
            <h2>Paired duels</h2>
            <span>same prompt · same base</span>
          </div>
          {duelRows.map((duel) => (
            <div className="duel-row" key={duel.task}>
              <span>
                {duel.task}
                <small>{duel.duration}</small>
              </span>
              <strong>{duel.winner}</strong>
              <span>over {duel.loser}</span>
            </div>
          ))}
        </section>
        <section className="rating-panel">
          <div className="section-heading">
            <h2>Bradley–Terry strength</h2>
            <span>weak prior</span>
          </div>
          {Object.entries(ratings)
            .sort(([, left], [, right]) => right - left)
            .map(([model, rating], index) => (
              <div className="rating-row" key={model}>
                <b>{index + 1}</b>
                <span>{model}</span>
                <i>
                  <em style={{ width: `${Math.min(100, rating * 42)}%` }}></em>
                </i>
                <strong>{rating.toFixed(2)}</strong>
              </div>
            ))}
        </section>
      </div>
    </div>
  );
}
