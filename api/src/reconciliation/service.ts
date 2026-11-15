import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { applyTransition } from '../domain/applyTransition.js';
import { logger } from '../lib/logger.js';
import type { PaymentRow, PaymentStatus } from '../payments/types.js';
import type { ProviderStatusReader } from '../provider/types.js';

export interface ReconcileOptions {
  olderThanMinutes?: number; // only payments created at least this long ago
  limit?: number; // max payments checked in one run
}

export interface ResolvedItem {
  paymentId: string;
  reference: string;
  merchantId: string;
  from: PaymentStatus;
  to: PaymentStatus;
  // status_applied: PENDING moved to the provider's final status through applyTransition
  // flag_cleared: our final status was confirmed by the provider, so the review flag is cleared
  // already_in_sync: a webhook resolved it while this run was in progress
  action: 'status_applied' | 'flag_cleared' | 'already_in_sync';
}

export interface MismatchItem {
  paymentId: string;
  reference: string;
  merchantId: string;
  reason: 'status' | 'amount';
  internalStatus: PaymentStatus;
  providerStatus: PaymentStatus;
  internalAmountPaise: number;
  providerAmountPaise: number;
}

export type UnresolvedReason = 'provider_timeout' | 'provider_error' | 'provider_pending' | 'provider_not_found' | 'internal_error';

export interface UnresolvedItem {
  paymentId: string;
  reference: string;
  merchantId: string;
  status: PaymentStatus;
  reason: UnresolvedReason;
  detail?: string;
}

export interface ReconcileReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  checked: number;
  resolved: ResolvedItem[];
  mismatches: MismatchItem[];
  unresolved: UnresolvedItem[];
}

type Finding =
  | { type: 'resolved'; item: ResolvedItem }
  | { type: 'mismatch'; item: MismatchItem }
  | { type: 'unresolved'; item: UnresolvedItem };

const CONCURRENCY = 5;

/**
 * CLAUDE.md 6.6. Compares PENDING / flagged payments with the provider's own records.
 * Safe to re-run: resolved payments are no longer candidates, mismatches are only reported, and the
 * ledger insert inside applyTransition is guarded by UNIQUE (payment_id, entry_type).
 */
export async function reconcile(reader: ProviderStatusReader, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const olderThanMinutes = options.olderThanMinutes ?? 0;
  const limit = options.limit ?? 200;

  const run = await pool.query<{ id: string; started_at: Date }>('INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id, started_at');
  const { id: runId, started_at: startedAt } = run.rows[0]!;

  const candidates = await pool.query<PaymentRow>(
    `SELECT * FROM payments
     WHERE (status = 'PENDING' OR needs_reconciliation)
       AND created_at <= now() - make_interval(mins => $1)
     ORDER BY created_at, id
     LIMIT $2`,
    [olderThanMinutes, limit],
  );

  const findings: Finding[] = [];
  for (let i = 0; i < candidates.rows.length; i += CONCURRENCY) {
    const batch = candidates.rows.slice(i, i + CONCURRENCY);
    findings.push(...(await Promise.all(batch.map((payment) => checkPayment(payment, reader, runId)))));
  }

  const report = {
    checked: candidates.rows.length,
    resolved: findings.flatMap((f) => (f.type === 'resolved' ? [f.item] : [])),
    mismatches: findings.flatMap((f) => (f.type === 'mismatch' ? [f.item] : [])),
    unresolved: findings.flatMap((f) => (f.type === 'unresolved' ? [f.item] : [])),
  };
  const finished = await pool.query<{ finished_at: Date }>(
    `UPDATE reconciliation_runs
     SET finished_at = now(), checked = $2, resolved = $3, mismatches = $4, unresolved = $5, report = $6
     WHERE id = $1 RETURNING finished_at`,
    [runId, report.checked, report.resolved.length, report.mismatches.length, report.unresolved.length, JSON.stringify(report)],
  );

  return { runId, startedAt: startedAt.toISOString(), finishedAt: finished.rows[0]!.finished_at.toISOString(), ...report };
}

async function checkPayment(payment: PaymentRow, reader: ProviderStatusReader, runId: string): Promise<Finding> {
  const base = { paymentId: payment.id, reference: payment.reference, merchantId: payment.merchant_id };
  const unresolved = (reason: UnresolvedReason, detail?: string): Finding => ({
    type: 'unresolved',
    item: { ...base, status: payment.status, reason, ...(detail ? { detail } : {}) },
  });

  try {
    const lookup = await reader.getPayment(payment.reference);
    // a timeout or error tells us nothing about the payment: leave it untouched
    if (lookup.kind === 'timeout') return unresolved('provider_timeout', lookup.message);
    if (lookup.kind === 'error') return unresolved('provider_error', lookup.message);
    const provider = lookup.value;
    if (!provider) return unresolved('provider_not_found');

    const mismatch = (reason: MismatchItem['reason'], internalStatus: PaymentStatus): Finding => ({
      type: 'mismatch',
      item: {
        ...base,
        reason,
        internalStatus,
        providerStatus: provider.status,
        internalAmountPaise: payment.amount_paise,
        providerAmountPaise: provider.amountPaise,
      },
    });

    if (provider.amountPaise !== payment.amount_paise) {
      await flagForReview(payment.id);
      return mismatch('amount', payment.status);
    }
    if (provider.status === 'PENDING') return unresolved('provider_pending');

    return await withTransaction(async (tx): Promise<Finding> => {
      // duplicate guard #2 again: lock the row so a webhook arriving right now is serialised with us
      const locked = (await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [payment.id])).rows[0]!;

      if (locked.status === provider.status) {
        if (!locked.needs_reconciliation) {
          return { type: 'resolved', item: { ...base, from: payment.status, to: locked.status, action: 'already_in_sync' } };
        }
        await tx.query('UPDATE payments SET needs_reconciliation = false, updated_at = now() WHERE id = $1', [locked.id]);
        return { type: 'resolved', item: { ...base, from: locked.status, to: locked.status, action: 'flag_cleared' } };
      }

      if (locked.status === 'PENDING') {
        const result = await applyTransition(tx, locked, provider.status, {
          source: 'reconciliation',
          sourceRef: runId,
          actor: 'reconciliation',
          note: `provider reports ${provider.status}`,
          providerPaymentId: provider.providerPaymentId,
        });
        if (result.outcome === 'applied') {
          return { type: 'resolved', item: { ...base, from: 'PENDING', to: provider.status, action: 'status_applied' } };
        }
      }

      // our final status disagrees with the provider's final status: never overwrite, a human decides
      await tx.query('UPDATE payments SET needs_reconciliation = true, updated_at = now() WHERE id = $1 AND NOT needs_reconciliation', [
        locked.id,
      ]);
      return mismatch('status', locked.status);
    });
  } catch (err) {
    logger.error({ err, reference: payment.reference, runId }, 'reconciliation failed for payment');
    return unresolved('internal_error', 'unexpected error while reconciling this payment');
  }
}

async function flagForReview(paymentId: string): Promise<void> {
  await pool.query('UPDATE payments SET needs_reconciliation = true, updated_at = now() WHERE id = $1 AND NOT needs_reconciliation', [
    paymentId,
  ]);
}
