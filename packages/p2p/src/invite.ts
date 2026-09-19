import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const RoomInviteSchema = z.object({
  version: z.literal(1),
  roomId: z.string().min(1).max(64),
  repositoryFingerprint: z.string().min(1),
  authorityPublicKey: z.string().regex(/^[a-f0-9]{64}$/),
  eventCoreKey: z.string().regex(/^[a-f0-9]{64}$/),
  capability: z.string().min(32),
});
export type RoomInvite = z.infer<typeof RoomInviteSchema>;

const INVITE_PREFIX = 'agentigram://join/';

export function createCapability(): string {
  return randomBytes(32).toString('base64url');
}

export function encodeInvite(invite: RoomInvite): string {
  const parsed = RoomInviteSchema.parse(invite);
  return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(parsed)).toString('base64url')}`;
}

export function decodeInvite(value: string): RoomInvite {
  if (!value.startsWith(INVITE_PREFIX))
    throw new InvalidInviteError('invite must start with agentigram://join/');
  try {
    return RoomInviteSchema.parse(
      JSON.parse(Buffer.from(value.slice(INVITE_PREFIX.length), 'base64url').toString('utf8')),
    );
  } catch (error) {
    if (error instanceof InvalidInviteError) throw error;
    throw new InvalidInviteError(error instanceof Error ? error.message : 'invalid invite');
  }
}

export function discoveryTopic(invite: Pick<RoomInvite, 'roomId' | 'capability'>): Buffer {
  return createHash('sha256')
    .update(`agentigram:v1:${invite.roomId}:${invite.capability}`)
    .digest();
}

export class InvalidInviteError extends Error {
  override readonly name = 'InvalidInviteError';
}
