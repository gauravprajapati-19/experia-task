import type { Logger } from 'pino';
import { ulid } from 'ulid';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { AppError } from '../lib/errors.js';
import { requestHash } from '../lib/hash.js';
import type { PaymentProvider, ProviderRegistration, ProviderResult } from '../provider/types.js';
import type { CreatePaymentInput } from './schemas.js';
import type { PaymentRow } from './types.js';

export interface CreatePaymentParams {
  merchantId: string;
  userId: string;
  idempotencyKey: string;
  input: CreatePaymentInput;
}

export interface CreatePaymentResult {
  payment: PaymentRow;
  replayed: boolean;
}

/**
 * CLAUDE.md 6.2. The UNIQUE (merchant_id, idempotency_key) constraint is what makes this safe:
 * concurrent requests with one key race on the INSERT, exactly one row wins, and the losers fall
 * through to the replay/409 branch. There is no application-level "check, then insert".
 */
export async function createPayment(
  params: CreatePaymentParams,
  provider: PaymentProvider | null,
  log: Logger,
): Promise<CreatePaymentResult> {
  const { merchantId, userId, idempotencyKey, input } = params;
  const hash = requestHash(input);

  const result = await withTransaction(async (tx): Promise<CreatePaymentResult> => {
    const inserted = await tx.query<PaymentRow>(
      `INSERT INTO payments (merchant_id, reference, amount_paise, currency, status,
                             idempotency_key, request_hash, description, customer_email)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8)
       ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        merchantId,
        `PAY_${ulid()}`,
        input.amountPaise,
        input.currency,
        idempotencyKey,
        hash,
        input.description ?? null,
        input.customerEmail ?? null,
      ],
    );

    const created = inserted.rows[0];
    if (created) {
      await tx.query(
        `INSERT INTO payment_audit_log (payment_id, from_status, to_status, source, actor, note)
         VALUES ($1, NULL, 'PENDING', 'api', $2, 'payment created')`,
        [created.id, userId],
      );
      return { payment: created, replayed: false };
    }

    // the key was already used. Under READ COMMITTED this statement sees the winning row, because
    // ON CONFLICT waited for the other transaction to commit before deciding there was a conflict.
    const existing = await tx.query<PaymentRow>(
      'SELECT * FROM payments WHERE merchant_id = $1 AND idempotency_key = $2',
      [merchantId, idempotencyKey],
    );
    const payment = existing.rows[0];
    if (!payment) throw new Error('idempotency conflict without an existing payment'); // unreachable
    if (payment.request_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body');
    }
    return { payment, replayed: true };
  });

  if (result.replayed || !provider) return result;
  // registered after COMMIT: the payment exists whatever the provider does
  return { payment: await registerWithProvider(result.payment, provider, log), replayed: false };
}

async function registerWithProvider(payment: PaymentRow, provider: PaymentProvider, log: Logger): Promise<PaymentRow> {
  let outcome: ProviderResult<ProviderRegistration>;
  try {
    outcome = await provider.registerPayment({ reference: payment.reference, amountPaise: payment.amount_paise });
  } catch (err) {
    log.error({ err, reference: payment.reference }, 'provider client threw unexpectedly');
    outcome = { kind: 'error', message: 'unexpected provider client error' };
  }

  if (outcome.kind === 'ok') {
    const { rows } = await pool.query<PaymentRow>(
      `UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, $2), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [payment.id, outcome.value.providerPaymentId],
    );
    return rows[0] ?? payment;
  }

  // CLAUDE.md 6.2 step 5: a timeout or error means the outcome is UNKNOWN. The payment stays PENDING
  // and is flagged for reconciliation; it is never marked FAILED here.
  log.warn({ reference: payment.reference, kind: outcome.kind }, 'provider registration did not complete');
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payments SET needs_reconciliation = true, last_provider_error = $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [payment.id, `${outcome.kind}: ${outcome.message}`],
  );
  return rows[0] ?? payment;
}
