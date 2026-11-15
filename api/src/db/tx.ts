import type pg from 'pg';
import { pool } from './pool.js';

/** runs `fn` inside BEGIN/COMMIT on one dedicated client; rolls back on any error */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      connectionBroken = true; // don't return a broken connection to the pool
    });
    throw err;
  } finally {
    client.release(connectionBroken);
  }
}
