# Prompt 0 — Bootstrap (M0, run once, together)

**Who runs it:** the Part 1 owner, on one laptop, with all four of you watching (about 60–90 minutes). Put `spec.md` and `CLAUDE.md` in an empty folder first, `git init`, then paste the prompt below into Claude Code from that folder.

**When it's done:** push to GitHub, everyone clones, and each person runs their own part prompt (01–04). Review the protocol package together before freezing it.

---

```text
You are bootstrapping the Clankergram monorepo. Read CLAUDE.md and spec.md in full before doing anything. They are the source of truth.

Goal: a scaffold in which all four teammates can start working in parallel today, each against the simulator, without waiting on each other. Nothing here needs to be clever; everything needs to be correct, typed and tested.

Do this in order, committing after each step:

1. Workspace scaffold
   - pnpm workspace with every package and app listed in CLAUDE.md "Repo layout" (packages/*, apps/*, demo-repo/, docs/decisions.md).
   - Root: package.json with scripts build, test, typecheck, lint, sim; tsconfig.base.json (strict, ES2022, NodeNext, declaration, composite where useful); biome.json; .gitignore (node_modules, dist, .env*, .dev.vars, .wrangler); .nvmrc = 22.
   - Each package: package.json named @clankergram/<dir>, "type": "module", src/index.ts, a README.md stating owner part and purpose (copy from CLAUDE.md), a vitest config, one passing smoke test.
   - GitHub Actions workflow: pnpm install, typecheck, lint, test on push and PR.
   - Do not add Turborepo or Nx.

2. @clankergram/protocol v0 (the shared contract — take the most care here)
   - Zod schemas and inferred types for the event envelope exactly as in spec.md "Data model and event schema".
   - A discriminated union over payload.type covering every type in the spec's payload table. Give each payload the concrete fields the spec implies. Examples: FILE_READ {path, symbols?}; FILE_WRITE {path, worktree}; API_DELTA {module, changes: [{symbol, before, after, breaking, reason}]}; INTENT {task, files, symbols}; LEASE_REQUESTED {symbols, ttlMs}; LEASE_GRANTED {leaseId, symbols, fencingToken, expiresAt}; COLLISION {collisionId, tier, symbols, writerSession, affectedSessions, detail}; PROPOSAL {collisionId, contract}; COUNTER {collisionId, contract, reason}; ACCEPT {collisionId}; CONTRACT_COMPILED {contractId, checkFiles}; SPEC_MERGE_RESULT {baseCommit, sessions, typeErrors, failingTests, notRun}; MARKET_OPENED {marketId, kind, question, outcomes, b, closesAt, subjectSession?}; TRADE {marketId, memberId, outcome, shares}. Infer the rest from the spec; keep them small and add optional fields rather than guessing too much.
   - A Contract schema matching the JSON in spec.md "What a contract is".
   - Wire messages for WebSocket: client→server HELLO {roomId, lastSeq, client: 'daemon'|'dashboard'|'worker', sessionId?, token}, SUBMIT {event without seq/ts}, HEARTBEAT; server→client WELCOME {roomState, fromSeq}, EVENTS {events[]}, ACK {id, seq}, ERROR {code, message, id?}.
   - RoomState type: sessions/presence, leases, collisions, negotiations (state machine states from the spec), contracts, markets, teamSummary.
   - Include PERSONA_LINES {lines: [{speaker, text, seq}]} as a dashboard-only payload for rendered dialogue.
   - Helpers: symbolKey(path, exportName, member?, kind) and parseSymbolKey; isAgentVisible(eventType) returning false for MARKET_*, TRADE and PERSONA_LINES.
   - Export JSON Schema for the MCP tool inputs (zod-to-json-schema or Zod's native JSON Schema export, whichever is current).
   - Tests: every payload type round-trips; invalid payloads are rejected; isAgentVisible excludes league events.

3. @clankergram/reducer v0
   - Signature: reduce(state: RoomState, event: Event): { state: RoomState; effects: Effect[] }. Effects include Broadcast {to: sessionIds | 'dashboards'}, ScheduleAlarm, RequestSpecMerge, RequestContractCompile, PersistBatch.
   - Implement only: SESSION_STARTED/ENDED, HEARTBEAT, presence, INTENT stored on session, and broadcast of every event to dashboards. Leave leases, collisions and negotiation as TODO stubs with failing-skipped tests named after the spec behaviours, so Part 1 has a checklist.

4. @clankergram/simulator v0
   - Scenario format: an ordered list of { atMs, event } plus expected assertions.
   - Scenario "user-id-uuid" exactly as described in CLAUDE.md "The canonical scenario", four sessions (Frontend, Backend, Payments, Security) with distinct models.
   - Mock coordinator: a Node WebSocket server on :8787 (path /room/:roomId) that speaks the wire protocol, assigns seq, runs the real reducer, replays on HELLO from lastSeq, and can play a scenario on a timer. This is what Parts 2 and 4 develop against.
   - `pnpm sim` and `pnpm sim --scenario user-id-uuid` work from the repo root.

5. Stubs for other parts (signatures only, so imports compile)
   - @clankergram/analysis: indexRepo(root), apiDelta(base, worktree), resolveIntent(text, files, symbols?), readSetFromFiles(paths), assessImpact(remoteFacts, localIndex, localReadSet) with types from protocol; bodies throw NotImplementedError.
   - @clankergram/contracts: compile(contract), verifyRun(evidence).
   - @clankergram/league: createMarket, quote, trade, resolve, voidMarket signatures; @clankergram/stats: betaPosterior, bradleyTerry, thompsonPick signatures; @clankergram/personas: render(eventsWindow, personaCards).
   - apps/web: bare Next.js App Router app with a /team/[teamId] page that connects to ws://localhost:8787 and prints the raw event stream.
   - apps/daemon: a CLI with `clankergram --help` and a `dev-connect` command that connects to the mock coordinator and logs events.
   - demo-repo/: leave a README placeholder; Part 3 builds it.

6. Finish
   - Run pnpm install, pnpm -r typecheck, pnpm lint, pnpm -r test. All must pass (skipped TODO tests are fine).
   - Start `pnpm sim --scenario user-id-uuid`, connect the web app and the daemon dev-connect, and confirm both receive events in order. Report what you observed.
   - Write docs/decisions.md entries for every choice the spec didn't make.
   - Print a short summary: package list, the protocol payload types and their fields, how to run the simulator, and anything you were unsure about.

Before step 1, check current versions of: Wrangler and the Durable Objects SQLite/WebSocket hibernation APIs, @modelcontextprotocol/sdk, Next.js, Zod, Vitest, Biome. Use current stable and note the versions in docs/decisions.md.

Ask me before deviating from the spec on anything in step 2. Otherwise proceed without asking.
```
