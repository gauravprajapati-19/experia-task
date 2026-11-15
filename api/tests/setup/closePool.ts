import { afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';

// Each test file gets its own module graph (and pool); close it so the worker can exit.
afterAll(async () => {
  await pool.end();
});
