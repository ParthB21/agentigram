'use strict';

const MAX_EVENTS = 8;
const MAX_OUTPUT = 900;

function buildExplanationRequest(events) {
  const safeEvents = Array.isArray(events)
    ? events.slice(-MAX_EVENTS).map(sanitizePresentationEvent).filter(Boolean)
    : [];
  if (safeEvents.length === 0) return null;

  const sourceSeqs = [...new Set(safeEvents.flatMap((event) => event.sourceSeqs))].sort(
    (left, right) => left - right,
  );
  const fallback = safeEvents
    .map((event) => `${citation(event.sourceSeqs)} ${event.fallback}`)
    .join('\n');

  const system = [
    'You are Agentigram Local Narrator, a presentation-only observer.',
    'Explain the deterministic coordination facts below in plain language.',
    'Never decide leases, edit permission, collisions, contracts, or next actions.',
    'Do not invent facts. Keep the whole answer under 110 words.',
    `The host will attach the authoritative source citation ${citation(sourceSeqs)}.`,
  ].join(' ');

  const compact = safeEvents.map(({ seq, sourceSeqs: sources, type, actor, facts }) => ({
    seq,
    sourceSeqs: sources,
    type,
    actor,
    facts,
  }));

  return {
    sourceSeqs,
    fallback,
    history: [
      { role: 'system', content: system },
      { role: 'user', content: `Local redacted event facts:\n${JSON.stringify(compact)}` },
    ],
  };
}

function finalizeExplanation(text, request) {
  const generated = sanitizeText(text)
    .replace(/\[(?:event|seq|source|#)[^\]]*\]/gi, '')
    .replace(/\b(?:event|seq(?:uence)?|source)\s*#?\d+\b/gi, '')
    .replace(/#\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_OUTPUT);
  if (!generated) return request.fallback;
  return `${citation(request.sourceSeqs)} ${generated}`;
}

function sanitizePresentationEvent(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isInteger(value.seq) || value.seq < 0) return null;
  if (!Array.isArray(value.sourceSeqs) || value.sourceSeqs.length === 0) return null;
  const sourceSeqs = value.sourceSeqs
    .filter((seq) => Number.isInteger(seq) && seq >= 0)
    .slice(0, 8);
  if (sourceSeqs.length === 0) return null;
  return {
    seq: value.seq,
    sourceSeqs,
    type: sanitizeText(value.type).slice(0, 40),
    actor: sanitizeText(value.actor).slice(0, 80),
    facts: sanitizeValue(value.facts, 0),
    fallback: sanitizeText(value.fallback).slice(0, 500),
  };
}

function sanitizeValue(value, depth) {
  if (depth > 3) return '[TRUNCATED]';
  if (typeof value === 'string') return sanitizeText(value).slice(0, 240);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [sanitizeText(key).slice(0, 40), sanitizeValue(item, depth + 1)]),
    );
  }
  return null;
}

function sanitizeText(value) {
  let out = String(value ?? '');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]');
  out = out.replace(/\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{10,}/g, '[REDACTED_TOKEN]');
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED_TOKEN]');
  out = out.replace(/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED_KEY]');
  out = out.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer [REDACTED]');
  out = out.replace(
    /(?<![\w.#/-])(authorization|api[_-]?key|x-api-key|token|secret|password|passwd)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    (_match, key, separator) => `${key}${separator}[REDACTED]`,
  );
  out = [...out]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  return out.replace(/\s+/g, ' ').trim();
}

function citation(sourceSeqs) {
  return `[source ${sourceSeqs.map((seq) => `#${seq}`).join(', ')}]`;
}

module.exports = {
  buildExplanationRequest,
  citation,
  finalizeExplanation,
  sanitizePresentationEvent,
  sanitizeText,
};
