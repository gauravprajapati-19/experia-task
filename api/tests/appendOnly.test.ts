import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createTestWorld, resetDb } from './helpers/db.js';

// Test 17: payment_audit_log and ledger_entries are append-only at the database level.
describe('append-only tables', () => {
  let paymentId: string;

  beforeEach(async () => {
    await resetDb();
    const world = await createTestWorld();
    paymentId = randomUUID();
    await pool.query(
      `WITH p AS (
         INSERT INTO payments (id, merchant_id, reference, amount_paise, status, idempotency_key, request_hash)
         VALUES ($1, $2, 'PAY_APPEND_ONLY_TEST', 10000, 'SUCCESS', 'append-only-key', 'hash')
       ), a AS (
         INSERT INTO payment_audit_log (payment_id, from_status, to_status, source) VALUES ($1, NULL, 'PENDING', 'api')
       )
       INSERT INTO ledger_entries (payment_id, merchant_id, entry_type, amount_paise) VALUES ($1, $2, 'CAPTURE', 10000)`,
      [paymentId, world.merchantA.id],
    );
  });

  it.each([
    ['UPDATE ledger_entries', `UPDATE ledger_entries SET amount_paise = 1 WHERE payment_id = $1`],
    ['DELETE ledger_entries', `DELETE FROM ledger_entries WHERE payment_id = $1`],
    ['UPDATE payment_audit_log', `UPDATE payment_audit_log SET to_status = 'FAILED' WHERE payment_id = $1`],
    ['DELETE payment_audit_log', `DELETE FROM payment_audit_log WHERE payment_id = $1`],
  ])('%s raises', async (_label, sql) => {
    await expect(pool.query(sql, [paymentId])).rejects.toThrow(/append-only/);
  });

  it('raises even when the statement matches no rows', async () => {
    await expect(pool.query(`DELETE FROM ledger_entries WHERE payment_id = $1`, [randomUUID()])).rejects.toThrow(/append-only/);
  });

  it('leaves the rows unchanged and still allows inserts', async () => {
    const { rows } = await pool.query<{ ledger: number; audit: number; amount: number }>(
      `SELECT (SELECT count(*)::int FROM ledger_entries) AS ledger,
              (SELECT count(*)::int FROM payment_audit_log) AS audit,
              (SELECT amount_paise FROM ledger_entries LIMIT 1) AS amount`,
    );
    expect(rows[0]).toEqual({ ledger: 1, audit: 1, amount: 10000 });

    await pool.query(
      `INSERT INTO payment_audit_log (payment_id, from_status, to_status, source) VALUES ($1, 'PENDING', 'SUCCESS', 'webhook')`,
      [paymentId],
    );
  });
});
