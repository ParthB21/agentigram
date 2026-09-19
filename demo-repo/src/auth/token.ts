// Demo-only tokens: `<userId>.<expiresAt>.<checksum>`. Not cryptographically secure; do not reuse.
const SECRET = 'demo-secret';
export const TOKEN_TTL_MS = 60 * 60 * 1000;

function checksum(userId: number, expiresAt: number): string {
  let h = 0;
  for (const ch of `${SECRET}:${userId}:${expiresAt}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16);
}

export function issueToken(
  userId: number,
  now: number,
  ttlMs: number = TOKEN_TTL_MS,
): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  return { token: `${userId}.${expiresAt}.${checksum(userId, expiresAt)}`, expiresAt };
}

/** Returns the user id a valid, unexpired token was issued for. */
export function verifyToken(token: string, now: number): number | undefined {
  const [id, exp, sum] = token.split('.');
  if (id === undefined || exp === undefined || sum === undefined) return undefined;
  const userId = Number(id);
  const expiresAt = Number(exp);
  if (!Number.isFinite(userId) || !Number.isFinite(expiresAt)) return undefined;
  if (expiresAt <= now || checksum(userId, expiresAt) !== sum) return undefined;
  return userId;
}
