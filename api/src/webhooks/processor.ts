import { applyTransition } from '../domain/applyTransition.js';
import { withTransaction } from '../db/tx.js';
import type { PaymentRow, PaymentStatus } from '../payments/types.js';
import type { WebhookEvent } from './schema.js';

export type WebhookResult =
  | { kind: 'duplicate'; }
  | { kind: 'unknown_payment'; }
  | { kind: 'applied'; status: PaymentStatus; }
  | { kind: 'stale'; status: PaymentStatus; }
  | { kind: 'invalid_transition'; status: PaymentStatus; };

/**
 * processes one verified, validated provider event in a single transaction (CLAUDE.md 6.3).
 * Every outcome, including unknown_payment and invalid_transition, is committed so the event is kept.
 */
export async function processWebhookEvent(event: WebhookEvent, payload: unknown): Promise<WebhookResult> {
  return withTransaction(async (tx): Promise<WebhookResult> => {
    // duplicate guard #1: UNIQUE provider_event_id. A concurrent copy of the same event blocks on
    // this INSERT until the first transaction commits, then gets no row back -> duplicate.
    // The outcome written here is provisional; it is replaced below before COMMIT.
    const inserted = await tx.query<{ id: string; }>(
      `INSERT INTO webhook_events (provider_event_id, payment_reference, event_status, occurred_at, payload, outcome)
       VALUES ($1, $2, $3, $4, $5, 'stale')
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [event.eventId, event.paymentReference, event.status, event.occurredAt, JSON.stringify(payload)],
    );
    const eventRow = inserted.rows[0];
    if (!eventRow) {
      // visibility only: count the repeat delivery on the stored event. A duplicate never reaches
      // the payment lock or applyTransition, so it cannot move money.
      await tx.query('UPDATE webhook_events SET duplicate_deliveries = duplicate_deliveries + 1 WHERE provider_event_id = $1', [
        event.eventId,
      ]);
      return { kind: 'duplicate' };
    }

    // duplicate guard #2: row lock. Different events for the same payment queue up here, and each
    // one sees the status left by the previous one (READ COMMITTED re-reads the locked row).
    const locked = await tx.query<PaymentRow>('SELECT * FROM payments WHERE reference = $1 FOR UPDATE', [
      event.paymentReference,
    ]);
    const payment = locked.rows[0];
    if (!payment) {
      await tx.query(`UPDATE webhook_events SET outcome = 'unknown_payment' WHERE id = $1`, [eventRow.id]);
      return { kind: 'unknown_payment' };
    }

    // duplicate guard #3 (unique ledger entry) lives inside applyTransition
    const result = await applyTransition(tx, payment, event.status, {
      source: 'webhook',
      sourceRef: event.eventId,
      providerPaymentId: event.providerPaymentId,
    });

    await tx.query('UPDATE webhook_events SET outcome = $2, payment_id = $3 WHERE id = $1', [
      eventRow.id,
      result.outcome,
      payment.id,
    ]);
    return { kind: result.outcome, status: result.payment.status };
  });
}
