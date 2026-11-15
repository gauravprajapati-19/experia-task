import type pg from 'pg';
import type { PaymentRow, PaymentStatus } from '../payments/types.js';
import { decideTransition } from './stateMachine.js';

export interface TransitionContext {
  source: 'webhook' | 'reconciliation';
  sourceRef: string; // webhook event id or reconciliation run id
  actor?: string;
  note?: string;
  providerPaymentId?: string; // filled in if the payment doesn't have one yet
}

export type TransitionOutcome = 'applied' | 'stale' | 'invalid_transition';

export interface TransitionResult {
  outcome: TransitionOutcome;
  payment: PaymentRow; // the row after this call
}

/**
 * the ONLY function that changes payments.status.
 *
 * Precondition: `payment` was read with SELECT ... FOR UPDATE in the transaction `tx`
 * (duplicate guard #2), so no other transaction can change it until we commit.
 */
export async function applyTransition(
  tx: pg.PoolClient,
  payment: PaymentRow,
  to: PaymentStatus,
  context: TransitionContext,
): Promise<TransitionResult> {
  const decision = decideTransition(payment.status, to);

  if (decision === 'stale') return { outcome: 'stale', payment };

  if (decision === 'invalid') {
    // a final status is never overwritten; a human (or reconciliation report) has to look at it
    const { rows } = await tx.query<PaymentRow>(
      'UPDATE payments SET needs_reconciliation = true, updated_at = now() WHERE id = $1 RETURNING *',
      [payment.id],
    );
    return { outcome: 'invalid_transition', payment: rows[0] ?? payment };
  }

  const { rows } = await tx.query<PaymentRow>(
    `UPDATE payments
     SET status = $2, needs_reconciliation = false, provider_payment_id = COALESCE(provider_payment_id, $3), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [payment.id, to, context.providerPaymentId ?? null],
  );
  const updated = rows[0];
  if (!updated) throw new Error(`payment ${payment.id} disappeared while locked`); // unreachable under FOR UPDATE

  await tx.query(
    `INSERT INTO payment_audit_log (payment_id, from_status, to_status, source, source_ref, actor, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [payment.id, payment.status, to, context.source, context.sourceRef, context.actor ?? null, context.note ?? null],
  );

  if (to === 'SUCCESS') {
    // duplicate guard #3: UNIQUE (payment_id, entry_type) means a payment can be captured at most once,
    // even if a bug ever let two SUCCESS transitions through.
    await tx.query(
      `INSERT INTO ledger_entries (payment_id, merchant_id, entry_type, amount_paise)
       VALUES ($1, $2, 'CAPTURE', $3)
       ON CONFLICT (payment_id, entry_type) DO NOTHING`,
      [updated.id, updated.merchant_id, updated.amount_paise],
    );
  }

  return { outcome: 'applied', payment: updated };
}
