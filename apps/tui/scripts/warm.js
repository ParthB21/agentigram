// Download and load the model once, then exit.
//
// First run pulls ~0.8 GB of weights. Doing that inside the TUI is fine — the
// room stays visible and collisions still show with deterministic wording — but
// nobody wants to discover it during a demo. Run `npm run warm` on each laptop
// beforehand and the cache is already there.
//
// Weights land in QVAC's own cache, so this is a one-off per machine, not per
// repository or per room.
const process = require('bare-process')

const modelName = Bare.argv[2] || 'LLAMA_3_2_1B_INST_Q4_0'

async function main() {
  const sdk = await import('@qvac/inference')
  const { llmPlugin } = await import('@qvac/inference/llamacpp-completion/plugin')
  sdk.registerPlugin(llmPlugin)

  const modelSrc = sdk[modelName]
  if (!modelSrc) throw new Error(`Unknown model: ${modelName}`)

  console.log(`warming ${modelName} — first run downloads the weights`)

  let last = -1
  const modelId = await sdk.loadModel({
    modelSrc,
    modelConfig: { ctx_size: 8192 },
    onProgress: ({ percentage }) => {
      // One line per whole percent: this usually runs in a scrollback, not a TUI.
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
  process.exit(1)
})
