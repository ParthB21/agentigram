// Stable voices without recordings.
//
// Parler conditions on a text description of the speaker, so a voice is just a
// sentence. Hashing the session id picks one from a fixed table, which makes it
// identical across restarts and across laptops: everyone hears "payments" as
// the same person.
const NAMES = ['Jon', 'Lea', 'Gary', 'Jenna', 'Mike', 'Laura']
const DELIVERY = [
  'monotone yet slightly fast in delivery',
  'expressive and animated with a slightly low pitch',
  'calm and slow with a clear, steady tone',
  'warm and moderately paced with a high pitch',
  'crisp and confident at a moderate pace'
]
const FIXED = 'with a very close recording that has almost no background noise.'

// FNV-1a, 32-bit. Not cryptographic; it only has to be stable and spread out.
function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function voiceFor(sessionId) {
  const h = hash(String(sessionId))
  const name = NAMES[h % NAMES.length]
  const delivery = DELIVERY[Math.floor(h / NAMES.length) % DELIVERY.length]
  return `${name}'s voice is ${delivery}, ${FIXED}`
}

module.exports = { voiceFor, NAMES, DELIVERY }
