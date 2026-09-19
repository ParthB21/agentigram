import { describe, expect, it } from 'vitest';
import {
  createCapability,
  decodeInvite,
  discoveryTopic,
  encodeInvite,
  InvalidInviteError,
  type RoomInvite,
} from './invite.js';

const invite = (): RoomInvite => ({
  version: 1,
  roomId: 'hackathon',
  repositoryFingerprint: 'repo-sha256',
  authorityPublicKey: 'a'.repeat(64),
  eventCoreKey: 'b'.repeat(64),
  capability: createCapability(),
});

describe('room invites', () => {
  it('round trips a capability without exposing it in the discovery topic', () => {
    const input = invite();
    expect(decodeInvite(encodeInvite(input))).toEqual(input);
    expect(discoveryTopic(input)).toHaveLength(32);
    expect(discoveryTopic(input).toString('hex')).not.toContain(input.capability);
  });

  it('rejects malformed invite URIs', () => {
    expect(() => decodeInvite('https://example.com')).toThrow(InvalidInviteError);
  });
});
