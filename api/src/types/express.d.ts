import type { AuthContext } from '../auth/types.js';

declare global {
  namespace Express {
    interface Request {
      /** set by requireAuth from a verified JWT */
      auth?: AuthContext;
    }
  }
}

export {};
