# Prompt 3 — Analysis and verification (Part 3)

**Owner:** whoever takes Part 3. Run from the repo root after the bootstrap is merged. Build the demo repo first: the other three parts test against it.

---

```text
You own Part 3 of Clankergram: the code-analysis engine and everything that proves a change is safe. This is the technical heart of the project: the claim is that we compute, deterministically, what would break if every agent's uncommitted work landed now. Read CLAUDE.md, then these spec.md sections closely: The novel core, Collision detection pipeline, Negotiation and the contract ledger, Model intelligence → Metric definitions, Security, Team split.

Your directories: packages/analysis, packages/contracts, apps/specmerge, apps/github, demo-repo/. Do not edit anything else. @clankergram/analysis runs inside Part 2's daemon; @clankergram/contracts is imported by Part 1's reducer. Keep both packages pure and fast, with no network calls except the clearly marked LLM fallback in resolveIntent.

Hard requirement: tiers 0–2 are deterministic and use no LLM. Every flag must name the exact symbol and the rule that fired.

M0/M1 — Demo repo and symbol index
- demo-repo/: a small but realistic TypeScript app the demo will be performed on. Modules: src/types/user.ts (User with id: number), src/auth/ (login, AuthResponse including userId), src/users/ (repository + service), src/checkout/ (checkout.ts and stripe.ts that use User.id and AuthResponse), src/security/ (middleware). Vitest tests for each module. It must typecheck in under 10 s cold and under 3 s incremental. Add a README listing the scripted demo tasks per role (Backend: migrate User.id to UUID string; Payments: implement checkout for the authenticated user; Frontend: checkout UI types; Security: auth middleware review) and the exact collision each should produce.
- packages/analysis indexRepo(root): build a TypeScript LanguageService over the repo (read tsconfig), compute every exported symbol with its key (use the protocol's symbolKey helper), kind, and a normalised signature string (checker.typeToString with stable flags), plus the module import graph and, for each module, the set of external symbol keys it references. Incremental updates on file change. Budget: under 2 s for the demo repo after warm-up.
- readSetFromFiles(paths): symbol keys defined in or referenced by those files.
- Tier 0 helper: file overlap between two write sets.
- Tests: fixture repos under packages/analysis/fixtures with expected indexes.

M2 — API delta, intent, impact
- apiDelta(base, worktree): for each module changed since the merge base, build the "before" program from git (read blobs at the base commit into an in-memory host) and the "after" from the worktree, compare exported surfaces, and classify each change. Breaking: removed export; renamed or removed member; type changed incompatibly (use checker.isTypeAssignableTo in the relevant direction — property types in outputs must remain assignable to old consumers; parameter types must still accept old arguments); changed enum/literal union members; changed function arity (required params added or removed). Additive: new export, new optional member, widened input. Every change reports {symbol, before, after, breaking, reason}. Build a fixture table of at least 25 before/after pairs covering each rule, including the User.id number→string case, and test them all.
- resolveIntent(text, files, symbols?): explicit symbols are validated against the index; files map to their exports; prose falls back to identifier matching against the index, and only then to an LLM call (Vercel AI SDK, structured output) that must return keys that exist in the index. Return a confidence per symbol and whether the LLM was used.
- assessImpact(remoteFacts, localIndex, localReadSet): given another session's INTENT or API_DELTA, return impacted local symbols and files: tier 1 (PREDICTED) when an intended symbol is in the local read set or its import closure; tier 2 (SEMANTIC) when a breaking API change hits a symbol the local session references. Include the exact local references (file:line) in detail. Part 2 calls this from the daemon; agree the exact signature with them now.
- Measure precision and recall on scripted scenarios and the demo tasks; print them in a test report.
- Done when: the User.id change is flagged as tier 1 before any edit and tier 2 after the edit, naming src/checkout/checkout.ts references, with zero LLM calls.

M3 — Speculative merge, contracts, GitHub
- apps/specmerge: a container service (Dockerfile; Fly Machines or Cloudflare Containers — check current docs and pick one, record why in docs/decisions.md). It keeps a warm clone of the repo with dependencies installed. POST /runs {roomId, baseCommit, diffs: [{sessionId, leaseSeq, patch}], contracts} applies patches in lease-seq order in a fresh worktree, records textual conflicts as their own result, runs tsc --noEmit --incremental, selects tests whose import graph reaches changed modules, runs them with a wall-clock cap, runs contract checks, and posts SPEC_MERGE_RESULT (and CONTRACT_RESULT) to the coordinator's /ingest endpoint with exact type errors (file, line, message) and failing test names. Report capped or skipped work as notRun; never report a pass that didn't run. Discard diffs after each run. Target: under 20 s on the demo repo.
- packages/contracts compile(contract): TypeScript type contracts → a type-assertion test file (expectTypeOf from Vitest, run in typecheck mode, or a tsc-checked .ts file — pick one and document it); runtime-shape contracts → a Zod schema + a Vitest test against fixtures; HTTP contracts → a request/response schema snapshot test. Output files go under .clankergram/contracts/ in the target repo and are deterministic for the same input. Tests: compile the User.id contract, run it against the demo repo before (fails) and after (passes) the migration.
- packages/contracts verifyRun(evidence): the pure function implementing the spec's "Verified success" definition (declared complete, trailer commits exist, required CI green, contracts pass, no human takeover). Part 1's reducer calls it to emit RUN_VERIFIED.
- apps/github: a GitHub App (Octokit). Webhooks: push, pull_request, pull_request_review, check_run, workflow_run. Verify signatures. Map commits to runs via the Clankergram-Run / Clankergram-Model trailers. Emit CI_RESULT and REVIEW_RESULT to /ingest. On PR open/synchronize, ask specmerge to run the room's active contracts against the PR head and publish a clankergram/contracts check run whose summary cites each agreement that failed (symbol, contract version, who agreed).
- Done when: after the negotiated User.id contract is compiled, a branch that reverts the type makes the PR check go red citing the agreement, and a correct branch goes green.

M4 — Demo hardening
- Tune the demo repo and specmerge for sub-20 s end to end; pre-warm the clone before the demo.
- Record a labelled replay set from rehearsals and publish precision/recall numbers for the dashboard.
- Add tree-sitter symbol-level indexing for one non-TS language as a degraded mode, only if time allows.

Throughout
- No LLM calls in tiers 0–2. Keep an eye on performance: log timings for indexRepo, apiDelta and assessImpact and fail a test if they exceed budget on the demo repo.
- Check current docs for the TypeScript compiler API version you're on, Octokit's GitHub App auth, and the container platform before coding against them.
- After each milestone: pnpm -r typecheck, pnpm lint, pnpm -r test, then run the user-id-uuid scenario against the demo repo. Report what works, the precision/recall you measured, and any signature other parts need to adopt.

Start with the demo repo and indexRepo. Show me a short plan first, then build.
```
