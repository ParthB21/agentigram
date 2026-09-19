import type { NewUser, User } from '../types/user';
import type { UserRepository } from './repository';

export class UserNotFoundError extends Error {
  constructor(id: number) {
    super(`user ${id} not found`);
    this.name = 'UserNotFoundError';
  }
}

export class UserService {
  constructor(private readonly repo: UserRepository) {}

  register(input: NewUser): User {
    if (!input.email.includes('@')) throw new Error('invalid email');
    if (this.repo.findByEmail(input.email)) throw new Error('email already registered');
    return this.repo.create(input);
  }

  getUser(id: number): User | undefined {
    return this.repo.findById(id);
  }

  findByEmail(email: string): User | undefined {
    return this.repo.findByEmail(email);
  }

  requireUser(id: number): User {
    const user = this.repo.findById(id);
    if (!user) throw new UserNotFoundError(id);
    return user;
  }
}
