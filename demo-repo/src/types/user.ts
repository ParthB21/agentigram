export type Role = 'admin' | 'member';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
}

export interface NewUser {
  email: string;
  name: string;
  role?: Role;
}
