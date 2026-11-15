import type { Request, RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { verifySessionToken } from './jwt.js';
import { SESSION_COOKIE, type AuthContext, type Role } from './types.js';

function extractToken(req: Request): string | null {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const cookie = cookies?.[SESSION_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
}

export function createRequireAuth(jwtSecret: string): RequestHandler {
  return (req, _res, next) => {
    const token = extractToken(req);
    const auth = token ? verifySessionToken(token, jwtSecret) : null;
    if (!auth) {
      next(unauthenticated());
      return;
    }
    req.auth = auth;
    next();
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    next(req.auth && roles.includes(req.auth.role) ? undefined : forbidden());
  };
}

/** the authenticated identity; only call after requireAuth */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
