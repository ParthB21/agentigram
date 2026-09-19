import { verifyToken } from '../auth/token';
import type { Role, User } from '../types/user';
import type { UserService } from '../users/service';

export interface AuthContext {
  user: User;
}

export interface MiddlewareDeps {
  users: UserService;
  now: () => number;
}

export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Authenticates a request from its `authorization: Bearer <token>` header. */
export function requireAuth(
  headers: Record<string, string | undefined>,
  deps: MiddlewareDeps,
): AuthContext {
  const header = headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('missing bearer token');
  const userId = verifyToken(header.slice('Bearer '.length), deps.now());
  if (userId === undefined) throw new UnauthorizedError('invalid or expired token');
  const user = deps.users.getUser(userId);
  if (!user) throw new UnauthorizedError('unknown user');
  return { user };
}

export function requireRole(context: AuthContext, role: Role): void {
  if (context.user.role !== role) throw new UnauthorizedError(`requires role ${role}`);
}
