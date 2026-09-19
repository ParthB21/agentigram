# Agentigram Pear Local Narrator

This is Agentigram's load-bearing local AI application, derived from
[`holepunchto/hello-pear-qvac-tui`](https://github.com/holepunchto/hello-pear-qvac-tui)
at commit `605eb96186d25b1b3f888bb234844e4216433c57` (Apache-2.0).

It is not a chat widget and it is not part of the coordination authority. One instance runs on each
participating laptop and explains a small, redacted window of notable events from that laptop's
Agentigram daemon. The daemon's reducer remains the only source of truth for leases, collisions,
contracts, negotiation state, and edit permission.

## What is retained from the starter

- `bin.mjs` is a Bare terminal application with a central `bare-tui` model/update/view loop.
- `lib/inference.js` launches `workers/qvac.js` with `PearRuntime.run`.
- UI/worker communication is framed JSON via `FramedStream`.
- Every inference has a request ID. Superseded and user-cancelled work calls QVAC cancellation;
  late deltas are ignored.
- QVAC owns its model in a worker, streams thinking/content/end/error frames, checks `run.final`, and
  explicitly cancels requests, unloads the model, and closes the SDK before shutdown.
- `app.js` and `workers/main.js` retain the Pear OTA worker pattern. A staged update is applied only
  after `ctrl+r`.
- The headless tests retain the starter's fake-inference and pure-UI architecture. They need no
  model or GPU.

Agentigram adds a second isolated worker, `workers/daemon.js`. It is a client only: it connects to
the existing local Unix socket on macOS/Linux or named pipe on Windows and never opens a network
listener.

## Privacy and authority boundary

The Pear app requests `type: "presentation"` from the local daemon. The daemon returns at most eight
whitelisted notable events newer than the app's cursor. Each item contains only deterministic event
facts, source event sequences, deterministic fallback text, and redacted, length-bounded free text.

The Pear app validates the response and redacts it again before constructing a compact prompt. It
removes model-authored event numbers and attaches the authoritative `[source #…]` citation itself.
QVAC output is kept only in the terminal process: it is never submitted to the daemon, appended to
Hypercore, sent to another coding agent, or used to make a coordination decision.

## Install and run

First start or join Agentigram in the repository and leave its daemon running. The first QVAC run
downloads and caches the selected model.

The workspace installs and pins `bare-runtime` 1.30.3, the version validated with the current QVAC
engine and Pear worker runtime. No global Bare installation is required; the `pnpm` commands select
the workspace binary.

### Apple Silicon macOS

```bash
npx pnpm@10.34.5 install

# Terminal 1: create/join and keep the daemon running
npx pnpm@10.34.5 agentigram create --root . --session backend --host claude

# Terminal 2: one local QVAC worker for this laptop
npx pnpm@10.34.5 run pear -- --root . --model SMOLLM2_360M_INST_Q8 --ctx 4096
```

### Windows x64 (PowerShell)

```powershell
npx pnpm@10.34.5 install

# Window 1: create/join and keep the daemon running
npx pnpm@10.34.5 agentigram join '<agentigram://invite>' --root . --session payments --host codex

# Window 2: the adapter discovers this repo's installation and named pipe
npx pnpm@10.34.5 run pear -- --root . --model SMOLLM2_360M_INST_Q8 --ctx 4096
```

Use `LLAMA_3_2_1B_INST_Q4_0` for the starter default or `QWEN3_600M_INST_Q4` for a
small reasoning model. `SMOLLM2_360M_INST_Q8` is the Agentigram default because its roughly 0.39 GB
download is a practical first-run smoke test. All prompt, reasoning, and output tokens share `--ctx`.

For a manually resolved endpoint, pass both `--socket <path>` and `--room <id>`. This only changes
which local endpoint the client opens; it does not expose the socket.

## Tests and builds

```bash
npx pnpm@10.34.5 --filter @agentigram/pear test
npx pnpm@10.34.5 --filter @agentigram/pear typecheck
npx pnpm@10.34.5 --filter @agentigram/pear make:darwin-arm64
npx pnpm@10.34.5 --filter @agentigram/pear make:win32-x64
```

Standalone builds use the checked-in npm lock in a disposable flat staging directory because
`bare-build` statically traverses npm-style dependency ancestry; the normal pnpm workspace remains
the development/runtime install. Set `WINDOWS_CERT_SHA1` for Windows signing. On macOS, set
`MAC_CODESIGN_IDENTITY` for hardened-runtime signing and `KEYCHAIN_PROFILE` to submit the resulting
archive with `notarytool`.

The QVAC-free tests cover prompt projection/redaction, source grounding, framed worker messages,
cancellation and stale results, deterministic fallback behavior, and terminal UI state/layout.

## OTA

OTA is disabled until `package.json#upgrade` contains a real `pear://` release key. Create and stage
that key with the Pear CLI, build a standalone, and run the installed binary with updates enabled.
The retained updater worker stages an update in the background; the UI requires `ctrl+r` before
applying it. Signing/notarization and Pear's stage/provision/multisig release flow still apply.

## Runtime limitations

- QVAC native support is platform, architecture, driver, and model dependent. The upstream packages
  publish macOS, Windows, and Linux builds for arm64/x64, but install success does not prove that a
  particular Metal/Vulkan device will load.
- Missing Bare/QVAC/native support is non-fatal to coordination. The TUI reports fallback mode and
  continues to render deterministic, cited explanations.
- Model loading and first download can take minutes. Integrated GPUs should start with the default
  360M model; larger models can be slow or exceed available memory.
- Headless tests deliberately do not prove native model loading. Run the real app once, observe
  `Local model … is ready`, trigger a notable event, cancel one explanation with `esc`, and confirm
  `ctrl+c` returns the terminal without hanging.
- Windows x64 was validated with a full model load, token generation, EOS, unload, and interactive
  TUI startup. This proves the native runtime path on the test machine, but not that llama.cpp chose
  Intel Arc GPU offload instead of CPU execution. macOS uses upstream QVAC's native-package
  selection and the commands above, but was not executed on this Windows host.

See [NOTICE](./NOTICE) and [LICENSE](./LICENSE) for derivation and license information.
