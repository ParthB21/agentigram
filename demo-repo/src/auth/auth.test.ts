import { describe, expect, it } from 'vitest';
import { UserRepository } from '../users/repository';
import { UserService } from '../users/service';
import { InvalidCredentialsError, login } from './login';
import { issueToken, verifyToken } from './token';

const NOW = 1_000_000;

describe('tokens', () => {
  it('round-trips a user id and rejects tampering and expiry', () => {
    const { token, expiresAt } = issueToken(7, NOW, 1000);
    expect(verifyToken(token, NOW)).toBe(7);
    expect(verifyToken(token, expiresAt)).toBeUndefined();
    expect(verifyToken(token.replace(/^7/, '8'), NOW)).toBeUndefined();
    expect(verifyToken('garbage', NOW)).toBeUndefined();
  });
});

describe('login', () => {
  const users = new UserService(new UserRepository());
  const user = users.register({ email: 'a@x.dev', name: 'A' });
  const deps = {
    users,
    passwords: { verify: (id: number, pw: string) => id === user.id && pw === 'pw' },
    now: () => NOW,
  };

  it('returns a token for the user', () => {
    const res = login({ email: 'a@x.dev', password: 'pw' }, deps);
    expect(res.userId).toBe(user.id);
    expect(verifyToken(res.token, NOW)).toBe(user.id);
  });

  it('rejects a wrong password or unknown email', () => {
    expect(() => login({ email: 'a@x.dev', password: 'no' }, deps)).toThrow(
      InvalidCredentialsError,
    );
    expect(() => login({ email: 'z@x.dev', password: 'pw' }, deps)).toThrow(
      InvalidCredentialsError,
    );
  });
});
