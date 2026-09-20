const process = require('bare-process')
const SpeechEngine = require('../lib/speech/engine.js')
const { Player } = require('../lib/speech/player.js')
const { voiceFor } = require('../lib/speech/voices.js')

const DEFAULT_TEXT = 'Agentigram voice check. Local speech is ready.'
const argv = Bare.argv.slice(2)
const textIndex = argv.indexOf('--text')
const text = textIndex >= 0 ? argv[textIndex + 1] : DEFAULT_TEXT

if (!text || !String(text).trim()) {
  console.error('speech test failed: --text must not be empty')
  process.exit(1)
}

async function main() {
  const engine = new SpeechEngine()
  const player = new Player()
  let lastProgress = -1
  engine.on('progress', (percentage) => {
    const whole = Math.floor(percentage)
    if (whole !== lastProgress && whole % 5 === 0) {
      lastProgress = whole
      console.log(`voice model ${whole}%`)
    }
  })
  engine.on('loaded', (gpu) => console.log(`voice model ready (${gpu ? 'Metal' : 'CPU'})`))

  try {
    const { samples, sampleRate } = await engine.synthesize(
      String(text).trim(),
      voiceFor('agentigram-test')
    )
    console.log(`playing ${samples.length} samples at ${sampleRate} Hz`)
    await player.play(samples, sampleRate, 0.8).done
    console.log('speech test passed')
  } finally {
    player.close()
    await engine.close()
  }
}

main().catch((err) => {
  console.error(`speech test failed: ${err?.stack || err?.message || err}`)
  process.exit(1)
})
