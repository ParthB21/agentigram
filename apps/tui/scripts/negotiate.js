// Run the negotiation prompts against the real model, headlessly.
//
// The UI tests use a fake model, which proves the wiring but says nothing about
// whether a 1B model produces a *useful* explanation and a parseable contract.
// This does the same two calls the TUI makes, prints what comes back, and
// reports whether the JSON survived — run it after changing a prompt.
const process = require('bare-process')
const {
  CONTRACT_FORMAT,
  contractPrompt,
  explainPrompt,
  parseContract,
  tidyExplanation
} = require('../lib/negotiator.js')

// The collision the two-laptop end-to-end run actually produces.
const COLLISION = {
  collisionId: '452c2e9a42af5a28',
  tier: 'PREDICTED',
  symbols: ['src/types/user.ts#User.id:property'],
  writerSession: 'backend',
  affectedSessions: ['payments'],
  detail:
    'backend is changing User.id while working on "Change User.id from number to a UUID string"; payments has already read it.'
}

const STATE = {
  agents: [
    {
      sessionId: 'backend',
      host: 'claude-code',
      intent: { task: 'Change User.id from number to a UUID string' }
    },
    { sessionId: 'payments', host: 'codex' }
  ]
}

async function collect(run) {
  let text = ''
  for await (const event of run.events) {
    if (event.type === 'contentDelta') text += event.text
  }
  await run.final
  return text
}

async function main() {
  const sdk = await import('@qvac/inference')
  const { llmPlugin } = await import('@qvac/inference/llamacpp-completion/plugin')
  sdk.registerPlugin(llmPlugin)

  const modelName = 'LLAMA_3_2_1B_INST_Q4_0'
  const modelId = await sdk.loadModel({
    modelSrc: sdk[modelName],
    modelConfig: { ctx_size: 8192 }
  })

  // Same order as the UI: contract first, then the explanation of it.
  const draftStarted = Date.now()
  const raw = await collect(
    sdk.completion({
      modelId,
      history: contractPrompt(COLLISION, STATE),
      captureThinking: true,
      responseFormat: CONTRACT_FORMAT
    })
  )
  const draftMs = Date.now() - draftStarted
  const { contract, generated } = parseContract(raw, COLLISION)

  const started = Date.now()
  const explanation = await collect(
    sdk.completion({
      modelId,
      history: explainPrompt(COLLISION, STATE, contract),
      captureThinking: true
    })
  )
  const explainMs = Date.now() - started

  console.log('\n─── raw contract output ' + '─'.repeat(42))
  console.log(raw.trim())

  console.log('\n─── parsed contract ' + '─'.repeat(46))
  console.log(JSON.stringify(contract, null, 2))
  console.log(`(${draftMs}ms, ${generated ? 'generated' : 'FELL BACK'})`)

  console.log('\n─── explanation ' + '─'.repeat(50))
  console.log(tidyExplanation(explanation, COLLISION))
  console.log(`(${explainMs}ms)`)

  await sdk.unloadModel({ modelId })
  await sdk.close()

  if (!generated) {
    console.error('\nthe grammar-constrained call did not parse — check CONTRACT_FORMAT')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
