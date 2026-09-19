export interface Credentials {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  userId: number;
  expiresAt: number;
}
