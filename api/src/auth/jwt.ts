import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { ROLES, SESSION_TTL_SECONDS, type AuthContext } from './types.js';

const claimsSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
  merchantId: z.uuid().nullable(),
});

export function signSessionToken(auth: AuthContext, secret: string): string {
  return jwt.sign({ role: auth.role, merchantId: auth.merchantId }, secret, {
    algorithm: 'HS256',
    subject: auth.userId,
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function verifySessionToken(token: string, secret: string): AuthContext | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }); // pinned: rejects alg=none and RS/HS confusion
    const claims = claimsSchema.safeParse(decoded);
    if (!claims.success) return null;
    return { userId: claims.data.sub, role: claims.data.role, merchantId: claims.data.merchantId };
  } catch {
    return null;
  }
}
