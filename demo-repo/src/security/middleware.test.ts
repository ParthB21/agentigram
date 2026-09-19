import { describe, expect, it } from 'vitest';
import { issueToken } from '../auth/token';
import { UserRepository } from '../users/repository';
import { UserService } from '../users/service';
import { requireAuth, requireRole, UnauthorizedError } from './middleware';

const NOW = 5_000;
const users = new UserService(new UserRepository());
const admin = users.register({ email: 'root@x.dev', name: 'Root', role: 'admin' });
const member = users.register({ email: 'm@x.dev', name: 'M' });
const deps = { users, now: () => NOW };
const bearer = (id: number) => ({ authorization: `Bearer ${issueToken(id, NOW).token}` });

describe('requireAuth', () => {
  it('authenticates a valid bearer token', () => {
    expect(requireAuth(bearer(member.id), deps).user.email).toBe('m@x.dev');
  });

  it('rejects missing, malformed and unknown-user tokens', () => {
    expect(() => requireAuth({}, deps)).toThrow(UnauthorizedError);
    expect(() => requireAuth({ authorization: 'Bearer nope' }, deps)).toThrow('invalid or expired');
    expect(() => requireAuth(bearer(999), deps)).toThrow('unknown user');
  });
});

describe('requireRole', () => {
  it('allows the role and rejects others', () => {
    expect(() => requireRole(requireAuth(bearer(admin.id), deps), 'admin')).not.toThrow();
    expect(() => requireRole(requireAuth(bearer(member.id), deps), 'admin')).toThrow(
      'requires role',
    );
  });
});
