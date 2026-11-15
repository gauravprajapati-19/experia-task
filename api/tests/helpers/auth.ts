import { signSessionToken } from '../../src/auth/jwt.js';
import { config } from '../../src/config.js';
import type { TestUser } from './db.js';

/** A valid session token for a test user, without going through bcrypt + /login. */
export function tokenFor(user: TestUser): string {
  return signSessionToken({ userId: user.id, role: user.role, merchantId: user.merchantId }, config.JWT_SECRET);
}

export function bearer(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}
