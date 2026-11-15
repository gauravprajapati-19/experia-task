import bcrypt from 'bcryptjs';
import { Router, type CookieOptions } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError, unauthenticated } from '../lib/errors.js';
import { signSessionToken } from './jwt.js';
import { createRequireAuth, getAuth } from './middleware.js';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from './types.js';
import { findUserByEmail, findUserById, toPublicUser } from './users.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(200),
});

// compared against when the email is unknown, so response time doesn't reveal which emails exist
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

export function createAuthRouter(config: AppConfig): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config.JWT_SECRET);

  const cookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
  };

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.LOGIN_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Please wait a minute and try again.'));
    },
  });

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { email, password } = loginSchema.parse(req.body);
      const user = await findUserByEmail(pool, email);
      const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordMatches) throw invalidCredentials();

      const token = signSessionToken({ userId: user.id, role: user.role, merchantId: user.merchantId }, config.JWT_SECRET);
      res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 });
      res.json({ token, user: toPublicUser(user) });
    }),
  );

  // works without a valid session too, so an expired cookie can always be cleared
  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await findUserById(pool, getAuth(req).userId);
      if (!user) throw unauthenticated(); // user deleted after the token was issued
      res.json({ user: toPublicUser(user) });
    }),
  );

  return router;
}
