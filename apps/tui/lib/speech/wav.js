// PCM -> WAV. QVAC hands back signed 16-bit mono samples as a plain number
// array; afplay wants a file with a header. 44 bytes of RIFF is all it takes.
const HEADER_BYTES = 44

function pcmToWav(samples, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`invalid sample rate: ${sampleRate}`)
  }

  const dataBytes = samples.length * 2
  const out = Buffer.alloc(HEADER_BYTES + dataBytes)

  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16) // fmt chunk size
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28) // byte rate
  out.writeUInt16LE(2, 32) // block align
  out.writeUInt16LE(16, 34) // bits per sample
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < samples.length; i++) {
    // Clamp rather than wrap: a stray out-of-range sample should click, not
    // flip sign and blast.
    const s = Math.max(-32768, Math.min(32767, Math.round(samples[i])))
    out.writeInt16LE(s, HEADER_BYTES + i * 2)
  }
  return out
}

module.exports = { pcmToWav, HEADER_BYTES }
