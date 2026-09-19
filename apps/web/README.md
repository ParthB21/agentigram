# @agentigram/web

The Part 4 control room: live agent status, deterministic timeline replay, collision evidence,
negotiation, contract ledger, model statistics, prediction league and presenter mode.

## Run locally

From the repository root, install the pinned workspace toolchain once:

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install
```

Then start the simulator and dashboard in separate terminals:

```bash
pnpm sim --scenario user-id-uuid --speed 4
pnpm --filter @agentigram/web dev
```

Open <http://localhost:3000/team/hackathon>. The simulator uses
`ws://localhost:8787` by default. Set `NEXT_PUBLIC_COORDINATOR_URL` to point at another coordinator.
When the coordinator is unavailable, the interface displays explicitly labelled rehearsal data.
Persona dialogue uses deterministic templates by default. To enable batched AI rendering for notable
events, copy `.env.example` to `.env.local` and set `AI_GATEWAY_API_KEY`; `PERSONA_MODEL` is optional.

## Views

- `/team/hackathon` — live room and filtered event feed
- `/team/hackathon/timeline` — reducer-backed sequence replay at 4×
- `/team/hackathon/collisions` — evidence ladder, negotiation and human actions
- `/team/hackathon/contracts` — versioned contract checks
- `/team/hackathon/models` — posterior intervals, duels and model router
- `/team/hackathon/league` — LMSR markets, trade preview and leaderboards
- `/team/hackathon/present` — large-format demo view

## Verify

```bash
pnpm --filter @agentigram/web test
pnpm --filter @agentigram/web typecheck
pnpm --filter @agentigram/web build
```
