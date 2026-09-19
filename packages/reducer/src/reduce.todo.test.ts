import { describe, it } from 'vitest';

/**
 * Part 1 checklist: each skipped test is named after a spec behaviour and fails until implemented.
 * Un-skip as you build. Sections refer to spec.md.
 */
const todo = (name: string) =>
  it.skip(name, () => {
    throw new Error(`TODO(part 1): ${name}`);
  });

describe('leases (Coordination core → Leases, not locks)', () => {
  todo('grants a lease atomically to the first claimant of a symbol');
  todo('denies the second claimant and emits LEASE_DENIED naming the holder');
  todo('sets the fencing token to the seq of the claim');
  todo('rejects a write carrying a stale fencing token');
  todo('renews the lease on the owner heartbeat');
  todo('expires the lease when a heartbeat is missed (ScheduleAlarm)');
  todo('expires the lease when the owner session ends');
  todo('lets a human override a lease from the dashboard');
});

describe('collisions (Collision detection pipeline)', () => {
  todo('tier 0: opens FILE_OVERLAP when two write sets share a path');
  todo('opens a negotiation for every collision');
  todo('resolves a collision when its negotiation is Verified');
});

describe('negotiation (Negotiation and the contract ledger)', () => {
  todo('Open → Proposed when the lease owner proposes a contract');
  todo('Proposed → Countered → Proposed on counter and revision');
  todo('Proposed → Accepted once every affected session accepts');
  todo('requests contract compilation on Accepted (RequestContractCompile)');
  todo('Accepted → Compiled on CONTRACT_COMPILED');
  todo('Compiled → Verified when a speculative merge passes');
  todo('escalates after 3 rounds without agreement');
  todo('escalates on timeout (default 5 minutes)');
  todo('Escalated → Accepted when a human decides');
  todo('supersedes a contract only through a new negotiation');
});

describe('verification', () => {
  todo('requests a speculative merge on any tier-2 collision (RequestSpecMerge)');
  todo('raises a collision against the ledger when a later diff breaks an accepted contract');
  todo('emits RUN_VERIFIED via contracts.verifyRun when the evidence is complete');
});

describe('routing (Coordination core → Routing)', () => {
  todo(
    'routes an event to every session whose read set or dependency closure contains an affected symbol',
  );
  todo('never routes MARKET_*, TRADE or PERSONA_LINES to agents');
  todo('routes symbol-less events by task description only after an LLM relevance result arrives');
});
