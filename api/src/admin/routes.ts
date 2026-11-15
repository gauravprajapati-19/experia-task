import { Router } from 'express';
import { z } from 'zod';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import type { AppConfig } from '../config.js';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import type { ProviderStatusReader } from '../provider/types.js';
import { reconcile } from '../reconciliation/service.js';

interface MerchantRow {
  id: string;
  name: string;
}

interface RunRow {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  checked: number;
  resolved: number;
  mismatches: number;
  unresolved: number;
  report: unknown;
}

const reconcileBodySchema = z
  .object({
    olderThanMinutes: z.number().int().min(0).max(10_080).default(0),
    limit: z.number().int().min(1).max(1_000).default(200),
  })
  .default({ olderThanMinutes: 0, limit: 200 });

const runsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** everything under /api/admin is admin-only; merchants get 403 */
export function createAdminRouter(config: AppConfig, deps: { statusReader: ProviderStatusReader; }): Router {
  const router = Router();
  router.use(createRequireAuth(config.JWT_SECRET), requireRole('admin'));

  router.get(
    '/merchants',
    asyncHandler(async (_req, res) => {
      const { rows } = await pool.query<MerchantRow>('SELECT id, name FROM merchants ORDER BY name, id');
      res.json({ items: rows });
    }),
  );

  router.post(
    '/reconcile',
    asyncHandler(async (req, res) => {
      const options = reconcileBodySchema.parse(req.body);
      const report = await reconcile(deps.statusReader, options);
      req.log.info(
        { runId: report.runId, checked: report.checked, resolved: report.resolved.length, mismatches: report.mismatches.length },
        'reconciliation run finished',
      );
      res.json(report);
    }),
  );

  router.get(
    '/reconciliation-runs',
    asyncHandler(async (req, res) => {
      const { limit } = runsQuerySchema.parse(req.query);
      const { rows } = await pool.query<RunRow>(
        `SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", checked, resolved, mismatches, unresolved, report
         FROM reconciliation_runs ORDER BY started_at DESC, id DESC LIMIT $1`,
        [limit],
      );
      res.json({ items: rows });
    }),
  );

  return router;
}
