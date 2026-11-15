import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createProviderClient } from '../src/provider/providerClient.js';
import { registerProviderPayment, setProviderStatus } from '../src/provider/mockProviderStore.js';
import type { ProviderStatusReader } from '../src/provider/types.js';
import { reconcile } from '../src/reconciliation/service.js';
import { bearer } from './helpers/auth.js';
import { createTestWorld, insertPayment, resetDb, type TestWorld } from './helpers/db.js';
import { listen, type RunningServer } from './helpers/server.js';

// The provider side is the REAL mock provider over HTTP (its own mock_provider_payments table).
// One payment is routed to a second mock provider that always hangs, so its lookup is a real
// client timeout. Behaviour is injected (rate 1 = always): nothing here is random.

let healthy: RunningServer;
let hanging: RunningServer;
let world: TestWorld;

beforeAll(async () => {
  healthy = await listen(createApp(undefined, { provider: null }));
  hanging = await listen(createApp(undefined, { provider: null, mockProvider: { timeoutRate: 1, hangMs: 10_000 } }));
});

afterAll(async () => {
  await Promise.all([healthy.close(), hanging.close()]);
});

beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

const noSleep = { random: () => 0.5, sleep: () => Promise.resolve() };

function readerRouting(timeoutReference: string): ProviderStatusReader {
  const real = createProviderClient({ baseUrl: `${healthy.url}/mock-provider`, timeoutMs: 2_000, ...noSleep });
  const hung = createProviderClient({ baseUrl: `${hanging.url}/mock-provider`, timeoutMs: 150, ...noSleep });
  return { getPayment: (reference) => (reference === timeoutReference ? hung : real).getPayment(reference) };
}

/** Internal payment plus (optionally) the provider's own record of it. */
async function scenario(internal: 'PENDING' | 'SUCCESS' | 'FAILED', provider: 'PENDING' | 'SUCCESS' | 'FAILED' | null, amountPaise = 10_000) {
  const payment = await insertPayment(world.merchantA.id, { status: internal, amountPaise });
  if (provider) {
    await registerProviderPayment(payment.reference, amountPaise);
    if (provider !== 'PENDING') await setProviderStatus(payment.reference, provider);
  }
  return payment;
}

/** Everything reconciliation could change, so two runs can be compared exactly. */
async function snapshot() {
  const [payments, ledger, audit] = await Promise.all([
    pool.query('SELECT id, status, needs_reconciliation, provider_payment_id, updated_at FROM payments ORDER BY id'),
    pool.query('SELECT payment_id, entry_type, amount_paise FROM ledger_entries ORDER BY payment_id'),
    pool.query('SELECT id, payment_id, from_status, to_status, source FROM payment_audit_log ORDER BY id'),
  ]);
  return { payments: payments.rows, ledger: ledger.rows, audit: audit.rows };
}

async function ledgerCount(paymentId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM ledger_entries WHERE payment_id = $1', [paymentId]);
  return rows[0]!.n;
}

describe('test 16: reconciliation', () => {
  it('resolves, leaves unknowns alone, reports mismatches without overwriting, and a second run changes nothing', async () => {
    const resolvable = await scenario('PENDING', 'SUCCESS', 249_900); // webhook was lost
    const timesOut = await scenario('PENDING', 'SUCCESS'); // provider would say SUCCESS, but we can't hear it
    const notFound = await scenario('PENDING', null);
    const stillPending = await scenario('PENDING', 'PENDING');
    const conflicting = await scenario('SUCCESS', 'FAILED');
    await pool.query('UPDATE payments SET needs_reconciliation = true WHERE id = $1', [conflicting.id]);
    await scenario('FAILED', 'FAILED'); // final and not flagged: not a candidate at all

    const app = createApp(undefined, { provider: null, statusReader: readerRouting(timesOut.reference) });
    const admin = bearer(world.admin);

    // --- first run ---------------------------------------------------------------------------
    const first = await request(app).post('/api/admin/reconcile').set(admin).send({}).expect(200);
    expect(first.body.checked).toBe(5);
    expect(first.body.resolved).toEqual([
      expect.objectContaining({ reference: resolvable.reference, from: 'PENDING', to: 'SUCCESS', action: 'status_applied' }),
    ]);
    expect(first.body.mismatches).toEqual([
      expect.objectContaining({ reference: conflicting.reference, reason: 'status', internalStatus: 'SUCCESS', providerStatus: 'FAILED' }),
    ]);
    const unresolved = Object.fromEntries(first.body.unresolved.map((u: { reference: string; reason: string }) => [u.reference, u.reason]));
    expect(unresolved).toEqual({
      [timesOut.reference]: 'provider_timeout',
      [notFound.reference]: 'provider_not_found',
      [stillPending.reference]: 'provider_pending',
    });

    // Resolved through applyTransition: SUCCESS, exactly 1 ledger entry, audit row from this run.
    const resolved = await pool.query(
      `SELECT p.status, p.needs_reconciliation, a.source, a.source_ref
       FROM payments p JOIN payment_audit_log a ON a.payment_id = p.id AND a.to_status = 'SUCCESS' WHERE p.id = $1`,
      [resolvable.id],
    );
    expect(resolved.rows).toEqual([{ status: 'SUCCESS', needs_reconciliation: false, source: 'reconciliation', source_ref: first.body.runId }]);
    expect(await ledgerCount(resolvable.id)).toBe(1);

    // Provider timeout: untouched (still PENDING, no ledger), even though the provider has SUCCESS.
    const untouched = await pool.query('SELECT status FROM payments WHERE id = ANY($1) ORDER BY status', [[timesOut.id, notFound.id]]);
    expect(untouched.rows).toEqual([{ status: 'PENDING' }, { status: 'PENDING' }]);
    expect(await ledgerCount(timesOut.id)).toBe(0);

    // Mismatch: our SUCCESS is NOT overwritten with the provider's FAILED, and it stays flagged.
    const mismatch = await pool.query('SELECT status, needs_reconciliation FROM payments WHERE id = $1', [conflicting.id]);
    expect(mismatch.rows).toEqual([{ status: 'SUCCESS', needs_reconciliation: true }]);

    // --- second run: idempotent ----------------------------------------------------------------
    const before = await snapshot();
    const second = await request(app).post('/api/admin/reconcile').set(admin).send({}).expect(200);
    expect(second.body.checked).toBe(4);
    expect(second.body.resolved).toEqual([]);
    expect(second.body.mismatches).toHaveLength(1);
    expect(second.body.unresolved).toHaveLength(3);
    expect(await snapshot()).toEqual(before);
    expect(await ledgerCount(resolvable.id)).toBe(1);

    // Both runs are persisted with their counts, newest first.
    const runs = await request(app).get('/api/admin/reconciliation-runs').set(admin).expect(200);
    expect(runs.body.items.map((r: { id: string; checked: number; resolved: number; mismatches: number; unresolved: number }) => [r.id, r.checked, r.resolved, r.mismatches, r.unresolved])).toEqual([
      [second.body.runId, 4, 0, 1, 3],
      [first.body.runId, 5, 1, 1, 3],
    ]);
    expect(runs.body.items[1].report.resolved[0].reference).toBe(resolvable.reference);
  }, 60_000);

  it('resolves PENDING -> FAILED without a ledger entry', async () => {
    const payment = await scenario('PENDING', 'FAILED');
    const report = await reconcile(readerRouting('none'));
    expect(report.resolved).toEqual([expect.objectContaining({ reference: payment.reference, to: 'FAILED', action: 'status_applied' })]);
    expect(await ledgerCount(payment.id)).toBe(0);
  });

  it('clears the review flag when the provider confirms our final status', async () => {
    const payment = await scenario('SUCCESS', 'SUCCESS');
    await pool.query('UPDATE payments SET needs_reconciliation = true WHERE id = $1', [payment.id]);
    const report = await reconcile(readerRouting('none'));
    expect(report.resolved).toEqual([expect.objectContaining({ reference: payment.reference, action: 'flag_cleared' })]);
    const { rows } = await pool.query('SELECT status, needs_reconciliation FROM payments WHERE id = $1', [payment.id]);
    expect(rows).toEqual([{ status: 'SUCCESS', needs_reconciliation: false }]);
  });

  it('reports an amount mismatch instead of resolving', async () => {
    const payment = await insertPayment(world.merchantA.id, { status: 'PENDING', amountPaise: 10_000 });
    await registerProviderPayment(payment.reference, 99_999);
    await setProviderStatus(payment.reference, 'SUCCESS');
    const report = await reconcile(readerRouting('none'));
    expect(report.mismatches).toEqual([expect.objectContaining({ reason: 'amount', internalAmountPaise: 10_000, providerAmountPaise: 99_999 })]);
    const { rows } = await pool.query('SELECT status, needs_reconciliation FROM payments WHERE id = $1', [payment.id]);
    expect(rows).toEqual([{ status: 'PENDING', needs_reconciliation: true }]);
  });

  it('respects olderThanMinutes and limit', async () => {
    const old = await insertPayment(world.merchantA.id, { createdAt: new Date(Date.now() - 30 * 60_000) });
    await insertPayment(world.merchantA.id); // created now
    const report = await reconcile(readerRouting('none'), { olderThanMinutes: 10, limit: 5 });
    expect(report.checked).toBe(1);
    expect(report.unresolved[0]!.reference).toBe(old.reference);
  });

  it('validates the request body (422)', async () => {
    const app = createApp(undefined, { provider: null, statusReader: readerRouting('none') });
    await request(app).post('/api/admin/reconcile').set(bearer(world.admin)).send({ limit: 0 }).expect(422);
  });
});
