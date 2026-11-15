import { pool } from '../db/pool.js';
import { PAYMENT_STATUSES, type PaymentRow, type PaymentStatus } from './types.js';

export interface PaymentFilters {
  merchantId: string | null; // null = all merchants (admin only, see resolveMerchantScope)
  status?: PaymentStatus;
  q?: string;
}

/**
 * builds a WHERE clause from fixed SQL fragments. Only `$n` placeholders are interpolated into the
 * SQL text; every user-supplied value travels as a bound parameter.
 */
function buildWhere(filters: PaymentFilters): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.merchantId) conditions.push(`merchant_id = ${param(filters.merchantId)}`);
  if (filters.status) conditions.push(`status = ${param(filters.status)}`);
  if (filters.q) {
    const pattern = param(`%${escapeLike(filters.q)}%`);
    conditions.push(`(reference ILIKE ${pattern} OR provider_payment_id ILIKE ${pattern})`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** makes `%`, `_` and `\` in a search term match literally (backslash is LIKE's default escape) */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listPayments(
  filters: PaymentFilters,
  page: number,
  pageSize: number,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const { where, params } = buildWhere(filters);
  const limit = `$${params.length + 1}`;
  const offset = `$${params.length + 2}`;
  const [items, count] = await Promise.all([
    pool.query<PaymentRow>(
      `SELECT * FROM payments ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
    pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM payments ${where}`, params),
  ]);
  return { rows: items.rows, total: count.rows[0]?.total ?? 0 };
}

export interface PaymentSummary {
  totalCount: number;
  totalAmountPaise: number;
  byStatus: Record<PaymentStatus, { count: number; amountPaise: number }>;
}

export async function getPaymentSummary(merchantId: string | null): Promise<PaymentSummary> {
  const { where, params } = buildWhere({ merchantId });
  const { rows } = await pool.query<{ status: PaymentStatus; count: number; amount_paise: number }>(
    `SELECT status, count(*)::int AS count, COALESCE(sum(amount_paise), 0)::bigint AS amount_paise
     FROM payments ${where} GROUP BY status`,
    params,
  );

  const byStatus = Object.fromEntries(
    PAYMENT_STATUSES.map((status) => [status, { count: 0, amountPaise: 0 }]),
  ) as PaymentSummary['byStatus'];
  for (const row of rows) byStatus[row.status] = { count: row.count, amountPaise: row.amount_paise };

  return {
    totalCount: rows.reduce((sum, row) => sum + row.count, 0),
    totalAmountPaise: rows.reduce((sum, row) => sum + row.amount_paise, 0),
    byStatus,
  };
}

/** scoped lookup: another merchant's payment comes back as null, exactly like a missing id (-> 404) */
export async function findPayment(id: string, merchantId: string | null): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    'SELECT * FROM payments WHERE id = $1 AND ($2::uuid IS NULL OR merchant_id = $2)',
    [id, merchantId],
  );
  return rows[0] ?? null;
}

export interface AuditEntry {
  id: number;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  source: 'api' | 'webhook' | 'reconciliation';
  sourceRef: string | null;
  actor: string | null;
  note: string | null;
  createdAt: Date;
}

export async function getAuditTimeline(paymentId: string): Promise<AuditEntry[]> {
  const { rows } = await pool.query<AuditEntry>(
    `SELECT id, from_status AS "fromStatus", to_status AS "toStatus", source, source_ref AS "sourceRef",
            actor, note, created_at AS "createdAt"
     FROM payment_audit_log WHERE payment_id = $1 ORDER BY id`,
    [paymentId],
  );
  return rows;
}

export interface WebhookEventSummary {
  eventId: string;
  status: string;
  outcome: string;
  /** signature-valid repeat deliveries of this event id; acknowledged and counted, never processed */
  duplicateDeliveries: number;
  occurredAt: Date;
  receivedAt: Date;
}

/** the stored payload is deliberately left out; signatures and headers are never stored at all */
export async function getWebhookEvents(paymentId: string): Promise<WebhookEventSummary[]> {
  const { rows } = await pool.query<WebhookEventSummary>(
    `SELECT provider_event_id AS "eventId", event_status AS status, outcome,
            duplicate_deliveries AS "duplicateDeliveries",
            occurred_at AS "occurredAt", received_at AS "receivedAt"
     FROM webhook_events WHERE payment_id = $1 ORDER BY received_at, id`,
    [paymentId],
  );
  return rows;
}
