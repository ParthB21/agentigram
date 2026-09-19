# Prompt 4 — Dashboard, prediction league and model stats (Part 4)

**Owner:** whoever takes Part 4. Run from the repo root after the bootstrap is merged. Develop against `pnpm sim --scenario user-id-uuid` the whole way; you should never need a real agent to make progress.

---

```text
You own Part 4 of Clankergram: what the humans see and the maths behind it. Read CLAUDE.md, then these spec.md sections closely: Product in one page, Model intelligence, Prediction league (non-wagering), Presentation layer, Negotiation and the contract ledger, Data model and event schema, Team split.

Your directories: apps/web, packages/league, packages/stats, packages/personas. Do not edit anything else. @clankergram/league is imported by Part 1's reducer, so it must be pure and deterministic (no Date.now, no Math.random, no I/O). @clankergram/stats may use randomness only through an injected seeded RNG.

Principles:
- Structured event = truth; banter = presentation. Every rendered line links to the seq of the event it depicts. Nothing you render ever reaches an agent.
- Never overstate the data. Every model metric shows n and an interval; "best" appears only when the spec's threshold is met.
- The dashboard is a pure view over the event stream plus Postgres history, so replay is free.

M1 — Room view
- apps/web (Next.js App Router, Tailwind, shadcn/ui, Motion, Recharts): a typed client for the wire protocol with resume from lastSeq; a client-side store that runs @clankergram/reducer over the stream so the UI shows exactly what the coordinator believes.
- /team/[teamId]: one card per agent (engineer, role, model, host, branch, task, status, lease badges, live activity pulse), a raw event feed with type filters, presence changes animated.
- /team/[teamId]/timeline: the full ordered event log with a scrubber that replays state at any seq (run the reducer up to that seq). Load history from the coordinator's export NDJSON.
- Visual quality matters: this is what judges look at. Define colour tokens once; support light and dark; one accent colour per agent role used consistently everywhere.

M2 — Collisions, negotiations, voice, personas
- /team/[teamId]/collisions: each collision with its tier ladder (FILE → PREDICTED → SEMANTIC → CONFIRMED) filling in as evidence arrives, the exact symbols, local references (file:line), and spec-merge errors when present.
- Negotiation view: the state machine as a live stepper; proposals and counters rendered as structured contract diffs (before → after, constraint); side-by-side persona dialogue and raw events; escalation banner with buttons for humans to decide (submits a human-actor ACCEPT) or break a lease.
- /team/[teamId]/contracts: the ledger with versions, who agreed, and current check status.
- packages/personas: render(eventsWindow, personaCards) → lines [{speaker, text, seq}]. Low-severity events use templates; notable ones use one batched LLM call (Vercel AI SDK, structured output) every 2–3 s. Persona cards per role (Frontend, Backend, Payments, Security) with tone and catchphrases in the spirit of the spec's examples. A safety pass keeps banter about code, not people. Rendering runs server-side in a Next.js route or background worker that connects as a 'worker' client; it submits them as PERSONA_LINES events (dashboard-only, already in the protocol), so every viewer and every replay sees the same dialogue and nothing reaches an agent.
- Voice: speechSynthesis with a distinct voice per role, a single global queue, priority interrupts for CONFIRMED collisions, build failures, blocked agents and escalations; Off / Normal / Unhinged toggle.

M3 — Prediction league and model stats
- packages/league (pure):
  - LMSR: cost(q, b) = b · logsumexp(q / b); prices via softmax(q / b); tradeCost = cost(q + Δ) − cost(q). Implement logsumexp stably. Support buying and selling (selling limited to holdings), categorical markets with any number of outcomes, and bucketed range markets.
  - Market lifecycle: open, close at closesAt or on the subject action, resolve with the resolving event's seq, void with full refunds. Balances per member per season (1,000 starting points; no transfers, no purchases).
  - Integrity rules from the spec: positions on your own agent are flagged; a human intervention on that agent after close voids that member's position and refunds it.
  - Scoring: points P&L and Brier score, where a member's forecast for a market is the price immediately after their last trade before close.
  - Auto-open rules as pure functions: given an event, which markets should open (push → "will CI pass", DUEL_STARTED → "who wins", COLLISION → "settled without escalation", SESSION_STARTED with task → time bucket market).
  - Property tests (fast-check): prices sum to 1; buying an outcome raises its price; cost is path-independent (trading in two steps costs the same as one); worst-case house loss ≤ b · ln(n); resolve + void conserve points.
  - Agree the exact function signatures with Part 1 early; their reducer calls you.
- packages/stats:
  - Beta-binomial success-rate posteriors per model × category with partial pooling (empirical-Bayes prior per model fitted across its categories); median and 80% interval.
  - Bootstrap medians and intervals for duration and cost.
  - P(A > B) by Monte Carlo with a seeded RNG; winner only when ≥ 0.9 and n ≥ 5 each.
  - Bradley–Terry ratings from duel results (MM algorithm with a weak prior so it converges with few duels), with bootstrap uncertainty.
  - Thompson-sampling router: score = sample − λ · cost / budget; return the pick plus a human-readable reason with n and interval.
  - Tests against hand-computed cases and simulated data where the true winner is known.
- /team/[teamId]/models: category × model grid showing posterior medians with interval whiskers and n; "not enough data" cells; click-through scorecards per model and category with every metric from the spec's metric table; duel history and Bradley–Terry ranking; the router's recommendation for a typed task.
- /team/[teamId]/league: open markets with live price sparklines, a trade sheet showing cost and resulting price before confirming, positions, resolution toasts (read aloud), the points and calibration leaderboards, badges, and the crowd-vs-router chart (Brier score of the crowd's closing price vs the router's posterior per category over the season). Show the non-wagering rules plainly on the page.

M4 — Demo polish
- A presenter mode: large type, the room view plus the active collision/negotiation, voice on.
- Seed the models and league pages from recorded rehearsal sessions, clearly labelled as seeded.
- Timeline replay of the full demo at 4× speed.
- Performance: the room view stays smooth at 50 events/s.

Throughout
- Everything must work against the simulator. Add simulator scenarios you need (ask Part 1 to merge them) rather than hard-coding fixtures in the UI.
- Check current docs for Next.js, Motion, Recharts, shadcn/ui and the Vercel AI SDK before using their APIs.
- After each milestone: pnpm -r typecheck, pnpm lint, pnpm -r test, then replay user-id-uuid and screenshot each page. Report what works, what you checked visually, and any protocol additions you need.

Start with M1. Show me a short plan first, then build.
```
