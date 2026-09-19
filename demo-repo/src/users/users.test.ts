import { describe, expect, it } from 'vitest';
import { UserRepository } from './repository';
import { UserNotFoundError, UserService } from './service';

const fixedNow = () => new Date('2026-09-19T00:00:00.000Z');
const setup = () => {
  const repo = new UserRepository(fixedNow);
  return { repo, service: new UserService(repo) };
};

describe('UserRepository', () => {
  it('assigns increasing ids and finds users by id and email', () => {
    const { repo } = setup();
    const a = repo.create({ email: 'a@x.dev', name: 'A' });
    const b = repo.create({ email: 'b@x.dev', name: 'B', role: 'admin' });
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a.role).toBe('member');
    expect(repo.findById(2)?.email).toBe('b@x.dev');
    expect(repo.findByEmail('a@x.dev')?.id).toBe(1);
    expect(repo.findByEmail('nobody@x.dev')).toBeUndefined();
    expect(repo.list()).toHaveLength(2);
    expect(a.createdAt).toEqual(fixedNow());
  });
});

describe('UserService', () => {
  it('registers users and rejects bad or duplicate emails', () => {
    const { service } = setup();
    const user = service.register({ email: 'a@x.dev', name: 'A' });
    expect(service.getUser(user.id)).toEqual(user);
    expect(() => service.register({ email: 'nope', name: 'N' })).toThrow('invalid email');
    expect(() => service.register({ email: 'a@x.dev', name: 'A2' })).toThrow('already registered');
  });

  it('requireUser throws for unknown ids', () => {
    const { service } = setup();
    expect(() => service.requireUser(99)).toThrow(UserNotFoundError);
  });
});
