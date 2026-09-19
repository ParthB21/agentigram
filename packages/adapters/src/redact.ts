/**
 * Secret redaction (CLAUDE.md rule 7: run on every outbound payload).
 * Ported from OpenAgents `adapters/utils.js#redactSecrets`, with two changes:
 *  - the long-opaque-token catch-all is opt-in, because payloads legitimately carry 40+ char
 *    commit SHAs and signature hashes;
 *  - `key=value` rules need a `:` or `=` and must not sit inside an identifier or symbol key
 *    (`src/a.ts#Auth.token:property` is not a secret).
 */

const NAMED_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]'],
  [/\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{10,}/g, '[REDACTED_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED_JWT]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer [REDACTED]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
  [/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]'],
];

const KEY_VALUE =
  /(?<![\w.#/-])(authorization|api[_-]?key|x-api-key|token|secret|password|passwd)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;

const OPAQUE_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

export type RedactOptions = {
  /** Also redact any long opaque token. On for logs/diagnostics, off for protocol payloads. */
  catchAll?: boolean;
};

export function redactSecrets(input: unknown, options: RedactOptions = {}): string {
  let out = String(input ?? '');
  for (const [pattern, replacement] of NAMED_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  return options.catchAll ? out.replace(OPAQUE_TOKEN, '[REDACTED]') : out;
}

/** Fields that are structural identifiers, never free text. Left untouched. */
const STRUCTURAL_KEYS = new Set([
  'id',
  'symbol',
  'symbols',
  'path',
  'paths',
  'file',
  'files',
  'module',
  'worktree',
  'commit',
  'baseCommit',
  'leaseId',
  'contractId',
  'collisionId',
  'sessionId',
  'signatureHash',
]);

/** Deep-redacts every free-text string in a payload; returns a copy. */
export function redactPayload<T>(value: T, options: RedactOptions = {}): T {
  return walk(value, options) as T;
}

function walk(value: unknown, options: RedactOptions, key?: string): unknown {
  if (typeof value === 'string') {
    return key && STRUCTURAL_KEYS.has(key) ? value : redactSecrets(value, options);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, options, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, options, k)]));
  }
  return value;
}
