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

The dashboard connects to the Agentigram daemon for this repository by default. Join or create a
room, then start the dashboard:

```bash
pnpm agentigram status
pnpm --filter @agentigram/web dev
```

Open <http://localhost:3000/team/hackathon>. The server-side bridge reads the private local daemon
socket and streams room snapshots and recent events to the browser. This works with Unix sockets on
macOS/Linux and named pipes on Windows; it does not expose the daemon on a network port. Set
`AGENTIGRAM_ROOT` if the web process is started outside the repository.

To use the simulator instead, start it and explicitly select its WebSocket endpoint:

```bash
pnpm sim --scenario user-id-uuid --speed 4
NEXT_PUBLIC_COORDINATOR_URL=ws://localhost:8787 pnpm --filter @agentigram/web dev
```

In PowerShell, set the variable with
`$env:NEXT_PUBLIC_COORDINATOR_URL = 'ws://localhost:8787'` before starting the web app. When neither
source is available, the interface displays explicitly labelled rehearsal data.
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
