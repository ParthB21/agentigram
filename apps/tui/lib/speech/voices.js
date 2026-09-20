// Stable voices without recordings.
//
// Parler conditions on a text description of the speaker, so a voice is just a
// sentence. Hashing the session id picks one from a fixed table, which makes it
// identical across restarts and across laptops: everyone hears "payments" as
// the same person.
//
// Jon and Lea are Parler-TTS Mini's cleanest benchmark speakers — the model was
// trained on the most studio-quality data for these two, so they produce stable,
// natural output. Other names (Gary, Mike) often trigger raspy, muffled, or
// eerie-sounding audio because the model's decoder loses conditioning.
const NAMES = ['Jon', 'Lea']
const DELIVERY = [
  'speaks in a natural, friendly, conversational tone with clear articulation and moderate pace',
  'speaks clearly, warmly, and confidently with a cheerful, smooth tone at a steady pace',
  'has a bright, crisp, articulate voice with an upbeat, natural cadence',
]
const FIXED = 'The recording quality is studio-grade, very clear, close-up, and completely free of background noise or distortion.'

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

