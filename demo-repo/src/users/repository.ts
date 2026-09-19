import type { NewUser, User } from '../types/user';

/** In-memory user store. `now` is injectable so tests are deterministic. */
export class UserRepository {
  private readonly users = new Map<number, User>();
  private nextId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: NewUser): User {
    const user: User = {
      id: this.nextId++,
      email: input.email,
      name: input.name,
      role: input.role ?? 'member',
      createdAt: this.now(),
    };
    this.users.set(user.id, user);
    return user;
  }

  findById(id: number): User | undefined {
    return this.users.get(id);
  }

  findByEmail(email: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return undefined;
  }

  list(): User[] {
    return [...this.users.values()];
  }
}
