# agentigram-tui

**Owner:** Half 1 / Part 2 · **Runtime:** Bare (not Node) · **Installs with npm, not pnpm**

The sovereign room view. A [Pear](https://docs.pears.com) terminal app that shows every agent in the
room, the collisions between them, and negotiates those collisions with a model running on this
laptop — no API key, no network round-trip, no cloud.

Forked from [`holepunchto/hello-pear-qvac-tui`](https://github.com/holepunchto/hello-pear-qvac-tui)
(Apache-2.0). See [What we changed](#what-we-changed-from-the-boilerplate).

```
┌ agentigram hackathon authority   daemon ✓   LLAMA_3_2_1B_INST_Q4_0 ✓ ────────┐
│ ● backend   claude-code  Change User.id from number to a UUID string  🔒1    │
│ ● payments  codex        idle                                                │
│ ─────────────────────────────────────────────────────────────────────────── │
│ backend SESSION_STARTED                                                      │
│ payments FILE_READ src/types/user.ts                                         │
│ backend INTENT Change User.id from number to a UUID string                   │
│ backend COLLISION PREDICTED src/types/user.ts#User.id:property               │
│ ─────────────────────────────────────────────────────────────────────────── │
│ PREDICTED  backend ↔ payments  User.id                                       │
│   User.id changes from a number to a UUID string, so payments has to adapt.  │
│   contract  User.id: number → string (UUID v4)                               │
│             every consumer must treat User.id as opaque                      │
│   [enter] send proposal   [r] redraft   [x] dismiss                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Running it

The TUI is a *view* on a room; the daemon owns the room. Start the daemon first:

```bash
# once per clone — installs both dependency trees, warms QVAC, and links `agg`
npm run setup

# then, from the repo you are coordinating
agg create backend --host claude   # or: agg join '<invite>' payments --host codex
agg start
```

`agg start` (also available as `agg tui`) resolves the daemon socket, checks the daemon is up, and
launches this app on the Bare binary that `npm install` put in `node_modules`. To run it directly:

```bash
npm start -- --socket "$AGENTIGRAM_SOCKET"
```

Flags: `--socket <path>`, `--model <QVAC constant>`, `--ctx <tokens>`, `--verbose`
(engine + native logging to stderr; redirect with `2> qvac.log`, never to stdout — bare-tui owns it).

## How it fits together

```
┌── Bare process (this app) ──────────┐
│  ui/app.js       room view, keys    │
│  lib/room.js ────┼── daemon socket ─┼──▶ Node daemon
│  lib/negotiator  prompts + parsing  │     hyperswarm + hypercore
│  workers/qvac.js QVAC, own thread   │     agent hooks, MCP
│  app.js          Pear OTA updates   │     TypeScript symbol index
└─────────────────────────────────────┘
```

Two Bare threads behind the UI, each over a `FramedStream`: `workers/qvac.js` holds the model, and
`workers/main.js` handles OTA updates. Loading a GGUF blocks its thread for seconds, so keeping it
off the UI thread is what keeps the spinner spinning and the keys responsive — and a native addon
that crashes takes its thread, not the terminal.

The daemon link is a plain newline-JSON socket (`subscribe` for a live stream of room frames;
`tool` and `narrate` for requests). `lib/room.js` reconnects on its own, so a daemon restart costs a
second of `retrying` rather than the session.

## What the local model is for

Detection stays deterministic. The daemon's symbol index and read-set intersection decide *that*
`backend` and `payments` collide, with no model involved — that is a hard rule, and tiers 0–2 never
call one. QVAC covers the two things set intersection cannot produce:

1. **The contract** — `User.id: number → string (UUID v4)`, plus the constraint both agents must
   honour. Generated under a `json_schema` response format, which llama.cpp compiles to GBNF and
   enforces during generation, so malformed JSON is unreachable rather than merely discouraged.
2. **The explanation** — one or two sentences a human can act on.

**The contract is drafted first and the explanation is generated from it.** Asked to explain a
collision cold, a 1B model infers a mechanism: it decides there must be a database or a cache
involved and says so confidently. Given a contract it has already drafted, the job becomes rephrasing
rather than inference, and it does that well. Measured on `LLAMA_3_2_1B_INST_Q4_0`: ~1s for the
contract, ~0.5–1s for the explanation.

Every generated artefact has a deterministic fallback built from the collision itself
(`fallbackContract`, `collision.detail`). A laptop whose weights never downloaded still shows every
collision and can still negotiate — the wording is blunter, and the panel says
`(deterministic draft)`. A bad generation costs prose quality, never a blank screen.

### Nothing leaves the laptop without a keypress

`PROPOSAL` is agent-visible: accepting one puts this model's words into a teammate's agent on another
machine. So it is bound to <kbd>enter</kbd>, never sent automatically. The explanation travels
separately as `PERSONA_LINES`, which is dashboard-only and never reaches an agent's context — a 1B
model's prose is not something to inject into Claude as instructions.

## Tests

```bash
npm test                     # 23 tests, ~250ms, no model, no daemon, no terminal
node scripts/bare.mjs ../scripts/negotiate.js   # the real model against a real collision
```

`ui/app.js` is a pure Elm-architecture model and `lib/negotiator.js` imports no SDK, so the whole
negotiation — collision in, contract and explanation out, proposal sent — is driven in `test/index.js`
with fakes. `scripts/negotiate.js` is the counterpart: it runs the actual prompts through the actual
model and fails if the grammar-constrained contract does not parse. Run it after touching a prompt.

## What we changed from the boilerplate

| Boilerplate | Here | Why |
| --- | --- | --- |
| `ui/app.js` — a chat transcript | The room view: agents, event feed, negotiation panel | Different product |
| `lib/inference.js` | `ask(history, responseFormat)` | Structured output for the contract |
| `workers/qvac.js` | Forwards `responseFormat` to `completion()` | Same |
| — | `lib/room.js` | Daemon socket client; the boilerplate has no peer state |
| — | `lib/negotiator.js` | Prompts, parsing, deterministic fallbacks |
| — | `scripts/bare.mjs`, `scripts/warm.js`, `scripts/negotiate.js` | Self-contained Bare launch; model pre-warm; live prompt check |
| `app.js`, `workers/main.js` | Unchanged | OTA updates are how the team gets new builds |
| `bare-runtime` 1.29.4 | `^1.33.4` | `@qvac/inference` needs `bare ^1.30.3`; 1.29.4's semver cannot even parse that range |
| — | `overrides: { "bare-module": "^7" }` | Bare 1.33.4 bundles bare-module 7; the transitive `^6` shadows it inside a worker thread |

### If a worker dies with `defaultProtocol.postresolve is not a function`

`bare-module` drifted out of sync with the bundled one again. Bare's own `Addon.resolve` calls
`protocol.postresolve`, which only exists from bare-module 7; `bare-worker`, `bare-sidecar` and
`lunte` all ask for `^6`. The npm copy wins inside a worker thread, so `npm run warm` (no worker)
passes while the TUI fails. Check with `npm ls bare-module` and widen the `overrides` pin.

### Versions checked (2026-09-19)

`@qvac/inference` 0.18.2 · `@qvac/llm-llamacpp` ^0.45.0 · `bare-tui` 0.3.0 · `bare-runtime` 1.33.4 ·
`pear-runtime` ^1.2.0. Verified against the installed `.d.ts`, not the docs: `responseFormat` is a
discriminated union (`text` | `json_object` | `json_schema`), and its `strict` flag is accepted for
OpenAI compatibility but does **not** imply `additionalProperties: false` or promote properties to
required — so `CONTRACT_FORMAT` spells both out.

### Why npm, and why outside the pnpm workspace

`bare-pack` and `bare-build` resolve modules and native addons by *statically* traversing `require()`
and `require.addon.resolve()` calls, which pnpm's symlinked store breaks. `pnpm-workspace.yaml`
excludes `apps/tui` with `!apps/tui`; this package keeps its own `package-lock.json`. Biome also skips
it — it is Prettier-formatted, per the Holepunch config the boilerplate ships.

## Packaging

`npm run make` builds a standalone binary for this platform (`make:win32-x64`, `make:darwin-arm64`,
…). OTA updates need a real Pear key: run `pear touch`, paste it into `package.json`'s `upgrade`
field, and the updater arms itself. Until then the app runs with updates disabled and says so.
Staged updates are never auto-applied — <kbd>ctrl+r</kbd> installs, so nothing swaps out mid-negotiation.

## Speech (QVAC Parler TTS)

`lib/speech/` is a headless speech engine; nothing in the UI uses it yet.

- Model `TTS_MINI_V1_EN_PARLER_TTS_Q8_0` (~1.1 GB, downloaded through the QVAC registry on first use) via `@qvac/tts-ggml@0.7.5` and the existing `@qvac/inference@0.18.2` `tts-ggml` plugin.
- Runs in its own worker (`workers/tts.js`). Metal on Apple Silicon, one retry on CPU.
- Output rate is pinned to 44100 Hz in the model config (the SDK client does not report it); PCM is wrapped as a temp WAV and played with `/usr/bin/afplay`.
- Voices come from hashing the session id into a Parler speaker description, so they are stable across restarts.
- Settings persist to `<storage>/speech.json`: volume 0.8, local agent on, remote agents muted.
- Tests (`npm test`) use fake engine/player/fs; the real model and audio path are not exercised by them.
