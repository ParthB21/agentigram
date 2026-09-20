// Download and load the model once, then exit.
//
// First run pulls ~0.74 GB of weights. Doing that inside the TUI is fine — the
// room stays visible and collisions still show with deterministic wording — but
// nobody wants to discover it during a demo. Run `npm run warm` on each laptop
// beforehand and the cache is already there.
//
// Weights land in QVAC's own cache (`~/.qvac/models`), so this is a one-off per
// machine, not per repository or per room.
//
//   npm run warm
//   npm run warm -- --fallback-src https://host/Llama-3.2-1B-Instruct-Q4_0.gguf
//   npm run warm -- --model-src /Volumes/usb/Llama-3.2-1B-Instruct-Q4_0.gguf
//
// QVAC's registry is itself peer-to-peer. On a hostile or locked-down network
// it fails with "Could not download ... from the registry on this network",
// sometimes reported as a file-locking error. The two flags above are the way
// out: `--fallback-src` keeps the registry as the first choice and falls back
// to a plain URL, and `--model-src` skips the registry altogether and takes a
// local file or URL — which is how you warm a laptop from a GGUF someone
// already has on a USB stick.
const process = require('bare-process')

const argv = Bare.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
// A bare first argument stays supported: `npm run warm -- WHISPER_TINY`.
const positional = argv.find(
  (value) => !value.startsWith('--') && argv[argv.indexOf(value) - 1]?.startsWith('--') !== true
)

const modelName = flag('--model') || positional || 'LLAMA_3_2_1B_INST_Q4_0'
const modelSrc = flag('--model-src')
const fallbackSrc = flag('--fallback-src')

async function main() {
  const sdk = await import('@qvac/inference')
  const { llmPlugin } = await import('@qvac/inference/llamacpp-completion/plugin')
  sdk.registerPlugin(llmPlugin)

  // A raw path or URL carries no engine, so the model type has to be stated.
  // A registry descriptor already knows it.
  const source = modelSrc || sdk[modelName]
  if (!source) throw new Error(`Unknown model: ${modelName}`)

  console.log(
    modelSrc
      ? `warming from ${modelSrc} (skipping the QVAC registry)`
      : `warming ${modelName} — first run downloads the weights`
  )
  if (fallbackSrc) console.log(`fallback source: ${fallbackSrc}`)

  let last = -1
  const modelId = await sdk.loadModel({
    modelSrc: source,
    ...(modelSrc && { modelType: 'llamacpp-completion' }),
    ...(fallbackSrc && { fallbackSrc }),
    modelConfig: { ctx_size: 8192 },
    onProgress: ({ percentage }) => {
      // One line per 5%: this usually runs in a scrollback, not a TUI.
      const whole = Math.floor(percentage)
      if (whole === last) return
      last = whole
      if (whole % 5 === 0) console.log(`  ${whole}%`)
    }
  })

  console.log('loaded, running one token to prove the engine works…')
  const run = sdk.completion({
    modelId,
    history: [{ role: 'user', content: 'Reply with the single word: ready' }]
  })
  let text = ''
  for await (const event of run.events) {
    if (event.type === 'contentDelta') text += event.text
  }
  await run.final
  console.log(`model says: ${text.trim() || '(nothing)'}`)

  await sdk.unloadModel({ modelId })
  await sdk.close()
  console.log('warm — this machine can negotiate offline now')
}

main().catch((err) => {
  console.error(`warm failed: ${err.stack || err.message}`)
  if (/registry|download|locked/i.test(err.message || '')) {
    console.error(
      '\nThe QVAC registry is peer-to-peer and some networks block it. Try, in order:\n' +
        '  1. rm -rf ~/.qvac/registry-corestore   (clears a stale lock, keeps downloaded weights)\n' +
        '  2. npm run warm -- --fallback-src <https URL to the .gguf>\n' +
        '  3. copy ~/.qvac/models/*.gguf from a machine that already has it, then\n' +
        '     npm run warm -- --model-src /path/to/Llama-3.2-1B-Instruct-Q4_0.gguf'
    )
  }
  process.exit(1)
})
