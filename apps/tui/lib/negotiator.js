// Negotiator — what the on-device model is actually for.
//
// Detection upstream is deterministic and stays that way: the daemon's symbol
// index and read-set overlap decide *that* two agents collide, with no model
// involved. This file covers the part that needs judgment and that no amount of
// set intersection produces — saying, in a sentence a human can act on, what
// the collision means, and drafting the contract the two agents negotiate over.
//
// Everything here is pure: prompts in, text out, parsed back. No QVAC import,
// no IPC. That keeps it testable with no model, no GPU and no terminal.
//
// The hard constraint is the model: LLAMA_3_2_1B at q4 is small, and small
// models drift out of any format you ask for. So every generated artefact has a
// deterministic fallback built from the collision itself. A bad generation
// costs prose quality, never a blank screen.

// `src/types/user.ts#User.id:property` -> `User.id`, and the file path.
function parseSymbolKey(key) {
  const hash = String(key).indexOf('#')
  if (hash < 0) return { file: String(key), name: String(key), kind: '' }
  const file = key.slice(0, hash)
  const rest = key.slice(hash + 1)
  const colon = rest.lastIndexOf(':')
  return colon < 0
    ? { file, name: rest, kind: '' }
    : { file, name: rest.slice(0, colon), kind: rest.slice(colon + 1) }
}

function sessionLine(state, sessionId) {
  const session = state?.agents?.find((agent) => agent.sessionId === sessionId)
  if (!session) return sessionId
  const task = session.intent?.task ? ` — working on "${session.intent.task}"` : ''
  return `${sessionId} (${session.host || 'agent'}${task})`
}

/** The shared framing. Kept short: every token here is one the answer cannot use. */
function facts(collision, state) {
  const symbols = (collision.symbols || []).map((key) => parseSymbolKey(key).name)
  return [
    `Writer: ${sessionLine(state, collision.writerSession)}`,
    `Affected: ${(collision.affectedSessions || []).map((id) => sessionLine(state, id)).join(', ')}`,
    symbols.length ? `Shared symbols: ${symbols.join(', ')}` : null,
    `Detected: ${collision.tier} — ${collision.detail}`
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Ask for the explanation — *after* the contract, and given it.
 *
 * Asked cold, this model infers: it decides the change must involve a database
 * or a cache nobody mentioned, and says so confidently. Given the contract, the
 * task stops being inference and becomes rephrasing "User.id: number → string
 * (UUID v4), payments read it" as a sentence, which it does well. So the
 * contract is drafted first and handed in here.
 *
 * Two sentences is a deliberate ceiling: this is read in a terminal pane beside
 * the room feed, and a paragraph would not be.
 */
function explainPrompt(collision, state, contract) {
  const change = contract
    ? `${contract.symbol} changes from ${contract.before} to ${contract.after}.`
    : ''
  return [
    {
      role: 'system',
      content:
        'You tell a developer watching a terminal what a pending code change means for their teammate. ' +
        'Answer in at most two short sentences, plain English, no preamble, no markdown, no bullet points, no quotation marks. ' +
        'Name the symbol, the old and new shape, and who has to adapt.\n' +
        // A 1B model will otherwise furnish the scene — databases, caches, API
        // calls that were never mentioned. Keep this a prohibition: given an
        // instruction shaped like a sentence it could write, this model copies
        // it out verbatim instead of following it.
        'Use ONLY the facts given. Never mention databases, caches, APIs, tests, or files that are not listed.'
    },
    { role: 'user', content: `${facts(collision, state)}\n${change}`.trim() }
  ]
}

/**
 * Ask for the contract. The schema is spelled out inline because a 1B model
 * follows a worked example far better than a description of one.
 */
function contractPrompt(collision, state) {
  const primary = (collision.symbols || [])[0]
  const name = primary ? parseSymbolKey(primary).name : 'the shared interface'
  return [
    {
      role: 'system',
      content:
        'You draft a contract that lets two AI coding agents proceed without breaking each other. ' +
        'Reply with ONE JSON object and nothing else. No markdown fence, no commentary.\n' +
        'Schema: {"symbol": string, "kind": "type"|"data-shape"|"http-api", "before": string, "after": string, "constraint": string, "migration": string}\n' +
        'Example: {"symbol":"User.id","kind":"type","before":"number","after":"string (UUID v4)",' +
        '"constraint":"every consumer must treat User.id as opaque and never do arithmetic on it",' +
        '"migration":"replace numeric comparisons with string equality"}'
    },
    {
      role: 'user',
      content: `${facts(collision, state)}\n\nDraft the contract for ${name}.`
    }
  ]
}

/**
 * Structured-output constraint for the contract call. llama.cpp converts this
 * to GBNF natively and enforces it during generation, which is what makes a 1B
 * model emit usable JSON at all — the grammar makes malformed output
 * unreachable rather than merely discouraged.
 *
 * `strict` is accepted by the SDK for OpenAI compatibility but does NOT imply
 * `additionalProperties: false` or promote every property to required, so both
 * are spelled out here.
 */
const CONTRACT_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'agentigram_contract',
    schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        kind: { type: 'string', enum: ['type', 'data-shape', 'http-api'] },
        before: { type: 'string' },
        after: { type: 'string' },
        constraint: { type: 'string' },
        migration: { type: 'string' }
      },
      required: ['symbol', 'kind', 'before', 'after', 'constraint'],
      additionalProperties: false
    }
  }
}

const KINDS = new Set(['type', 'data-shape', 'http-api'])

/**
 * What to show when the model produced nothing usable. Built only from facts
 * the deterministic layer already established, so it is always true — just
 * blunter than a good generation.
 */
function fallbackContract(collision) {
  const primary = (collision.symbols || [])[0]
  const symbol = primary ? parseSymbolKey(primary).name : collision.writerSession
  return {
    symbol,
    kind: 'type',
    before: 'current shape on main',
    after: 'changed by ' + collision.writerSession,
    constraint: `${collision.writerSession} must not change ${symbol} until ${(collision.affectedSessions || []).join(', ')} has adopted the new shape.`
  }
}

function fallbackExplanation(collision) {
  return collision.detail
}

/**
 * Pull the contract out of whatever the model produced. Small models wrap JSON
 * in fences, prefix it with "Here is the contract:", or emit a trailing comma —
 * so scan for the outermost braces rather than trusting the whole string, and
 * fall back rather than throw.
 */
function parseContract(text, collision) {
  const candidate = extractJson(text)
  if (!candidate) return { contract: fallbackContract(collision), generated: false }

  const contract = {
    symbol: string(candidate.symbol),
    kind: KINDS.has(candidate.kind) ? candidate.kind : 'type',
    before: string(candidate.before),
    after: string(candidate.after)
  }
  // The daemon validates against the real Zod schema anyway; this is about not
  // sending it something obviously empty and burning a round trip.
  if (!contract.symbol || !contract.before || !contract.after) {
    return { contract: fallbackContract(collision), generated: false }
  }
  const constraint = meaningful(string(candidate.constraint))
  const migration = meaningful(string(candidate.migration))
  contract.constraint = constraint || fallbackContract(collision).constraint
  if (migration) contract.migration = migration
  return { contract, generated: true }
}

function extractJson(text) {
  if (!text) return null
  const raw = String(text)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = raw.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // One common repair: a trailing comma before the closing brace.
    try {
      const parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
}

function string(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Small instruct models like to answer in quotation marks even when told not
 * to, and an unbalanced leading quote is the usual shape. Strip a matched pair,
 * or a lone opening one.
 */
function unquote(text) {
  const trimmed = text.trim()
  if (trimmed.length > 1 && /^["'“]/.test(trimmed) && /["'”]$/.test(trimmed)) {
    return trimmed.slice(1, -1).trim()
  }
  return /^["'“]/.test(trimmed) ? trimmed.slice(1).trim() : trimmed
}

/**
 * The grammar makes `constraint` required, so the model fills it even when it
 * has nothing to say — and "none" on the panel reads as "no constraint applies",
 * which is the opposite of what a collision means. Treat filler as absent and
 * let the deterministic constraint stand in.
 */
const FILLER = new Set(['none', 'n/a', 'na', 'null', 'nil', 'undefined', '-', 'no constraint'])

function meaningful(value) {
  return value && !FILLER.has(value.toLowerCase().replace(/[.]$/, '')) ? value : ''
}

/** Collapse a generation to the one or two sentences the pane has room for. */
function tidyExplanation(text, collision) {
  const flat = unquote(
    stripSpeaker(
      String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
    )
  )
  if (!flat) return fallbackExplanation(collision)
  const sentences = splitSentences(repairSymbolNames(flat, collision))
  const trimmed = sentences.slice(0, 2).join(' ').trim() || flat
  return trimmed.length > 400 ? `${trimmed.slice(0, 397)}…` : trimmed
}

/**
 * Split at sentence boundaries, not at every period: the one inside `User.id`
 * is not a full stop, and treating it as one truncated every explanation that
 * named a member symbol.
 *
 * This splits rather than matches. Matching sentences needs a "not a period"
 * class for the body, which by construction cannot span `User.id` — the match
 * then starts *after* the symbol and silently drops the first words. A boundary
 * is whitespace preceded by a terminator and followed by a capital.
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'“])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * Chat-tuned models sometimes answer in character — "Claude: the payments
 * application will…" — because the prompt is full of named participants. The
 * panel already attributes the line, so a speaker label is noise. Only strips a
 * short leading `Word:`, never a colon inside a real sentence.
 */
function stripSpeaker(text) {
  return text.replace(/^[A-Za-z][\w-]{0,15}:\s+(?=[A-Za-z"'“])/, '')
}

/**
 * This tokenizer emits `User. id` for `User.id`. Left alone it reads as a typo
 * and defeats the sentence splitter, so put the real names back using the
 * symbols the collision already carries.
 */
function repairSymbolNames(text, collision) {
  let out = text
  for (const key of collision.symbols || []) {
    const name = parseSymbolKey(key).name
    if (!name.includes('.')) continue
    const spaced = name.split('.').join('\\.\\s+')
    out = out.replace(new RegExp(spaced, 'gi'), name)
  }
  return out
}

module.exports = {
  CONTRACT_FORMAT,
  contractPrompt,
  explainPrompt,
  fallbackContract,
  fallbackExplanation,
  parseContract,
  parseSymbolKey,
  tidyExplanation
}
