'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { activeCollision, contract, demoEvents } from '../lib/demo-data';
import { submitHumanAction } from '../lib/human-actions';

const tiers = ['FILE', 'PREDICTED', 'SEMANTIC', 'CONFIRMED'];
const steps = ['Open', 'Proposed', 'Accepted', 'Compiled', 'Verified'];
const personasEndpoint = process.env.NEXT_PUBLIC_PERSONAS_ENDPOINT ?? '/api/personas';
const PersonaResponseSchema = z.object({
  lines: z.array(z.object({ speaker: z.string(), text: z.string(), seq: z.number() })),
});
const fallbackLines = [
  {
    speaker: 'Backend',
    text: 'The type is the contract. I’m moving User.id to UUID and owning the migration.',
    seq: 13,
  },
  {
    speaker: 'Payments',
    text: 'Checkout reads it. Holding the write until every caller moves with it.',
    seq: 12,
  },
];

export function CollisionView({ teamId }: { teamId: string }) {
  const [voice, setVoice] = useState<'Off' | 'Normal' | 'Unhinged'>('Off');
  const [notice, setNotice] = useState('');
  const [personaLines, setPersonaLines] = useState(fallbackLines);

  useEffect(() => {
    if (!personasEndpoint) return;

    const controller = new AbortController();
    void fetch(personasEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: demoEvents.filter((event) => event.seq >= 10 && event.seq <= 13),
      }),
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((body: unknown) => {
        const parsed = PersonaResponseSchema.safeParse(body);
        if (parsed.success && parsed.data.lines.length > 0)
          setPersonaLines(parsed.data.lines.slice(-3));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const act = async (kind: 'accept' | 'release') => {
    setNotice('Sending decision…');
    try {
      await submitHumanAction(
        teamId,
        kind === 'accept'
          ? { type: 'ACCEPT', collisionId: activeCollision.id }
          : { type: 'LEASE_RELEASED', leaseId: 'lease-user-id' },
      );
      setNotice(kind === 'accept' ? 'Decision accepted by the room.' : 'Lease released.');
    } catch {
      setNotice('Demo mode: decision previewed locally. Start the simulator to submit it.');
    }
  };

  const previewVoice = () => {
    if (voice === 'Off' || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const message = new SpeechSynthesisUtterance(
      'Semantic collision. Backend changed User dot I D while Payments still depends on the old type.',
    );
    message.rate = voice === 'Unhinged' ? 1.18 : 1;
    speechSynthesis.speak(message);
  };

  return (
    <div className="page collision-page">
      <header className="page-header">
        <div>
          <p className="context-line">Collision / {activeCollision.id}</p>
          <h1>The interface moved underneath checkout.</h1>
          <p>Exact evidence, a bounded negotiation, and a check that survives the conversation.</p>
        </div>
        <fieldset className="voice-control">
          <legend>Voice mode</legend>
          {(['Off', 'Normal', 'Unhinged'] as const).map((mode) => (
            <button
              className={voice === mode ? 'selected' : ''}
              key={mode}
              onClick={() => setVoice(mode)}
              type="button"
            >
              {mode}
            </button>
          ))}
        </fieldset>
      </header>

      <section className="tier-ladder" aria-label="Collision evidence tiers">
        {tiers.map((tier, index) => (
          <div className={index <= 2 ? 'reached' : ''} key={tier}>
            <i></i>
            <span>{tier}</span>
            <small>
              {
                ['same surface', 'read-set overlap', 'breaking type delta', 'spec merge proof'][
                  index
                ]
              }
            </small>
          </div>
        ))}
      </section>

      <div className="evidence-grid">
        <section className="evidence-panel">
          <div className="section-heading">
            <h2>Evidence</h2>
            <span>{Math.round(activeCollision.confidence * 100)}% confidence</span>
          </div>
          <code className="symbol-block">{activeCollision.symbol}</code>
          <p>{activeCollision.detail}</p>
          <h3>Local references</h3>
          <ul className="plain-list">
            {activeCollision.references.map((reference) => (
              <li key={reference}>
                <code>{reference}</code>
              </li>
            ))}
          </ul>
          <h3>Speculative merge</h3>
          <ul className="error-list">
            {activeCollision.typeErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </section>

        <section className="negotiation-panel">
          <div className="section-heading">
            <h2>Negotiation</h2>
            <span>Round 1 of 3</span>
          </div>
          <ol className="stepper">
            {steps.map((step, index) => (
              <li className={index < 4 ? 'done' : index === 4 ? 'current' : ''} key={step}>
                <i></i>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div className="contract-diff">
            <span>
              Before<code>{contract.before}</code>
            </span>
            <b>becomes</b>
            <span>
              After
              <code>
                {contract.after} · {contract.constraint}
              </code>
            </span>
          </div>
          <p className="migration-note">{contract.migration}</p>
          <div className="human-actions">
            <button type="button" onClick={() => void act('accept')}>
              Accept as human
            </button>
            <button className="secondary" type="button" onClick={() => void act('release')}>
              Break lease
            </button>
            <button className="secondary" type="button" onClick={previewVoice}>
              Preview alert
            </button>
          </div>
          {notice && (
            <p className="action-notice" role="status">
              {notice}
            </p>
          )}
        </section>
      </div>

      <section className="dialogue-panel">
        <div className="section-heading">
          <h2>What the room heard</h2>
          <span>Persona text never reaches agents</span>
        </div>
        {personaLines.map((line) => (
          <div className="dialogue-line" key={`${line.seq}-${line.speaker}`}>
            <span className={`role-avatar ${line.speaker.toLowerCase()}`}>{line.speaker[0]}</span>
            <p>
              <strong>{line.speaker}</strong>
              {line.text}
            </p>
            <a href={`#raw-${line.seq}`}>#{line.seq}</a>
          </div>
        ))}
      </section>
    </div>
  );
}
