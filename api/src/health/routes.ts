import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const healthRouter = Router();

healthRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: true });
    } catch (err) {
      req.log.warn({ err }, 'health check: database unreachable');
      res.status(503).json({ ok: false, db: false });
    }
  }),
);
