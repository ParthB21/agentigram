// Stable voices without recordings.
//
// Parler conditions on a text description of the speaker, so a voice is just a
// sentence. Hashing the session id picks one from a fixed table, which makes it
// identical across restarts and across laptops: everyone hears "payments" as
// the same person.
const NAMES = ['Jon', 'Lea', 'Gary', 'Jenna', 'Mike', 'Laura']
const DELIVERY = [
  'speaks in a natural, conversational tone with clear articulation and moderate pace',
  'has a bright, warm, and friendly voice with natural inflection at a comfortable pace',
  'speaks clearly and confidently with a calm, smooth tone at a steady pace',
  'has a crisp, articulate voice with an upbeat, natural delivery',
  'speaks with a pleasant, clear voice and natural, easy-going cadence',
]
const FIXED = 'The recording quality is excellent, close-up, and free of background noise.'

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
  return `${name} ${delivery}. ${FIXED}`
}

module.exports = { voiceFor, NAMES, DELIVERY }

