import type { UserService } from '../users/service';
import { issueToken } from './token';
import type { AuthResponse, Credentials } from './types';

export interface PasswordStore {
  verify(userId: number, password: string): boolean;
}

export interface LoginDeps {
  users: UserService;
  passwords: PasswordStore;
  now: () => number;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export function login(credentials: Credentials, deps: LoginDeps): AuthResponse {
  const user = deps.users.findByEmail(credentials.email);
  if (!user || !deps.passwords.verify(user.id, credentials.password)) {
    throw new InvalidCredentialsError();
  }
  const { token, expiresAt } = issueToken(user.id, deps.now());
  return { token, userId: user.id, expiresAt };
}
