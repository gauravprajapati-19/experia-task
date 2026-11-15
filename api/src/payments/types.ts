export const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentRow {
  id: string;
  merchant_id: string;
  reference: string;
  amount_paise: number;
  currency: string;
  status: PaymentStatus;
  idempotency_key: string;
  request_hash: string;
  provider_payment_id: string | null;
  needs_reconciliation: boolean;
  last_provider_error: string | null;
  description: string | null;
  customer_email: string | null;
  created_at: Date;
  updated_at: Date;
}

/** the API shape. Leaves out idempotency_key and request_hash, which are internal bookkeeping. */
export interface PaymentDto {
  id: string;
  merchantId: string;
  reference: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  providerPaymentId: string | null;
  needsReconciliation: boolean;
  lastProviderError: string | null;
  description: string | null;
  customerEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPaymentDto(row: PaymentRow): PaymentDto {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    reference: row.reference,
    amountPaise: row.amount_paise,
    currency: row.currency,
    status: row.status,
    providerPaymentId: row.provider_payment_id,
    needsReconciliation: row.needs_reconciliation,
    lastProviderError: row.last_provider_error,
    description: row.description,
    customerEmail: row.customer_email,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
