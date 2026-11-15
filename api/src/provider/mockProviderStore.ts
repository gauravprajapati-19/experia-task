import { ulid } from 'ulid';
import { pool } from '../db/pool.js';
import type { PaymentStatus } from '../payments/types.js';

// the simulated provider keeps its own table (mock_provider_payments), separate from `payments`,
// so reconciliation compares two independent sources of truth.

interface ProviderPaymentRow {
  provider_payment_id: string;
  payment_reference: string;
  amount_paise: number;
  status: PaymentStatus;
  updated_at: Date;
}

export interface ProviderPayment {
  providerPaymentId: string;
  reference: string;
  amountPaise: number;
  status: PaymentStatus;
  updatedAt: string;
}

function toProviderPayment(row: ProviderPaymentRow): ProviderPayment {
  return {
    providerPaymentId: row.provider_payment_id,
    reference: row.payment_reference,
    amountPaise: row.amount_paise,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** idempotent by reference: registering the same reference again returns the existing record */
export async function registerProviderPayment(
  reference: string,
  amountPaise: number,
): Promise<{ payment: ProviderPayment; created: boolean }> {
  const inserted = await pool.query<ProviderPaymentRow>(
    `INSERT INTO mock_provider_payments (provider_payment_id, payment_reference, amount_paise, status)
     VALUES ($1, $2, $3, 'PENDING')
     ON CONFLICT (payment_reference) DO NOTHING
     RETURNING *`,
    [`prov_${ulid()}`, reference, amountPaise],
  );
  if (inserted.rows[0]) return { payment: toProviderPayment(inserted.rows[0]), created: true };

  const existing = await findProviderPayment(reference);
  if (!existing) throw new Error('provider conflict without an existing record'); // unreachable
  return { payment: existing, created: false };
}

export async function findProviderPayment(reference: string): Promise<ProviderPayment | null> {
  const { rows } = await pool.query<ProviderPaymentRow>('SELECT * FROM mock_provider_payments WHERE payment_reference = $1', [
    reference,
  ]);
  return rows[0] ? toProviderPayment(rows[0]) : null;
}

export async function setProviderStatus(reference: string, status: PaymentStatus): Promise<ProviderPayment | null> {
  const { rows } = await pool.query<ProviderPaymentRow>(
    'UPDATE mock_provider_payments SET status = $2, updated_at = now() WHERE payment_reference = $1 RETURNING *',
    [reference, status],
  );
  return rows[0] ? toProviderPayment(rows[0]) : null;
}
