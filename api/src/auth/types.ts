export const ROLES = ['admin', 'merchant'] as const;
export type Role = (typeof ROLES)[number];

/** identity taken from a verified JWT. `merchantId` is null only for admins. */
export interface AuthContext {
  userId: string;
  role: Role;
  merchantId: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  merchantId: string | null;
  merchantName: string | null;
}

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_SECONDS = 60 * 60;
