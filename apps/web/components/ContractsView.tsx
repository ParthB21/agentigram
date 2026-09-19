import { contract } from '../lib/demo-data';

export function ContractsView() {
  return (
    <div className="page contracts-page">
      <header className="page-header">
        <div>
          <p className="context-line">Contract ledger</p>
          <h1>Agreements that execute.</h1>
          <p>Every accepted decision becomes a versioned check in speculative merge and CI.</p>
        </div>
        <span className="seed-label">1 active contract</span>
      </header>
      <section className="ledger-row">
        <div className="ledger-status">
          <i></i>
          <span>
            <strong>Compiled</strong>
            <small>awaiting final verification</small>
          </span>
        </div>
        <div className="ledger-main">
          <code>{contract.symbol}</code>
          <h2>
            {contract.before} becomes {contract.after}
          </h2>
          <p>
            {contract.constraint} · {contract.migration}
          </p>
        </div>
        <dl>
          <div>
            <dt>Version</dt>
            <dd>v{contract.version}</dd>
          </div>
          <div>
            <dt>Agreed by</dt>
            <dd>{contract.participants.join(', ')}</dd>
          </div>
          <div>
            <dt>Check</dt>
            <dd>
              <code>{contract.check}</code>
            </dd>
          </div>
        </dl>
      </section>
      <section className="verification-strip" aria-label="Contract verification path">
        <span className="passed">
          <i>✓</i>Accepted
        </span>
        <b></b>
        <span className="passed">
          <i>✓</i>Compiled
        </span>
        <b></b>
        <span className="passed">
          <i>✓</i>Spec merge
        </span>
        <b></b>
        <span>
          <i>4</i>GitHub check
        </span>
      </section>
      <section className="contract-code">
        <div className="section-heading">
          <h2>Generated assertion</h2>
          <span>deterministic output</span>
        </div>
        <pre>
          <code>{`import { expectTypeOf } from 'vitest';\nimport type { User } from '../../src/types/user.js';\n\nexpectTypeOf<User['id']>().toEqualTypeOf<string>();`}</code>
        </pre>
      </section>
    </div>
  );
}
