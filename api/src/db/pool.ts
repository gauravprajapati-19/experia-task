import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// BIGINT (int8) arrives as a string by default. Amounts are capped far below 2^53,
// so convert to number, but fail loudly rather than silently lose precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('BIGINT value exceeds Number.MAX_SAFE_INTEGER');
  return parsed;
});

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 15_000, // serverless Postgres (e.g. Neon) may need a moment to wake up
  idleTimeoutMillis: 30_000,
});

// an idle client can be dropped by the server; log it instead of crashing the process
pool.on('error', (err) => logger.error({ err }, 'idle PostgreSQL client error'));

/** anything that can run a query: the pool or a client inside a transaction */
export type Queryable = pg.Pool | pg.PoolClient;
