// every call goes through the same-origin /api proxy, so the httpOnly cookie authenticates it
// and no token is ever stored in JavaScript

export const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'merchant';
  merchantId: string | null;
  merchantName: string | null;
}

export interface Merchant {
  id: string;
  name: string;
}

export interface Payment {
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

export interface PaymentPage {
  items: Payment[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaymentSummary {
  totalCount: number;
  totalAmountPaise: number;
  byStatus: Record<PaymentStatus, { count: number; amountPaise: number }>;
}

export type AuditSource = 'api' | 'webhook' | 'reconciliation';

export interface AuditEntry {
  id: number;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  source: AuditSource;
  sourceRef: string | null;
  actor: string | null;
  note: string | null;
  createdAt: string;
}

export type WebhookOutcome = 'applied' | 'duplicate' | 'stale' | 'invalid_transition' | 'unknown_payment';

export interface WebhookEvent {
  eventId: string;
  status: string;
  outcome: WebhookOutcome;
  /** signature-valid repeat deliveries of this event id: acknowledged as duplicates, never processed */
  duplicateDeliveries: number;
  occurredAt: string;
  receivedAt: string;
}

export interface PaymentDetails {
  payment: Payment;
  auditTimeline: AuditEntry[];
  webhookEvents: WebhookEvent[];
}

export interface PaymentFilters {
  page: number;
  pageSize: number;
  status?: PaymentStatus;
  q?: string;
  merchantId?: string;
}

export interface CreatePaymentInput {
  amountPaise: number;
  description?: string;
  customerEmail?: string;
}

/** an error answered by the API (`{ error: { code, message, details } }`) or a network failure (status 0) */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function isErrorBody(body: unknown): body is ErrorBody {
  const error = (body as Partial<ErrorBody> | null)?.error;
  return typeof error?.code === 'string' && typeof error.message === 'string';
}

/** the session expired or was never there: clear the cookie and send the user to sign in */
function handleUnauthorized(): void {
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => {
    window.location.assign(`/login?next=${next}`);
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') handleUnauthorized();
    if (isErrorBody(body)) throw new ApiError(res.status, body.error.code, body.error.message, body.error.details);
    const message = res.status >= 500 ? 'The server is unavailable right now. Try again in a moment.' : `Request failed (${res.status}).`;
    throw new ApiError(res.status, `HTTP_${res.status}`, message);
  }
  return body as T;
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User }>('/auth/me').then((body) => body.user),

  merchants: () => request<{ items: Merchant[] }>('/admin/merchants').then((body) => body.items),

  listPayments: (filters: PaymentFilters) => request<PaymentPage>(`/payments${toQuery({ ...filters })}`),

  summary: (merchantId?: string) => request<PaymentSummary>(`/payments/summary${toQuery({ merchantId })}`),

  payment: (id: string) => request<PaymentDetails>(`/payments/${encodeURIComponent(id)}`),

  /** the caller supplies the Idempotency-Key so a retry of the same submission is replayed, not duplicated */
  createPayment: (input: CreatePaymentInput, idempotencyKey: string) =>
    request<{ payment: Payment }>('/payments', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    }).then((body) => body.payment),
};
