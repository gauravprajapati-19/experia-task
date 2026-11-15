import { z } from 'zod';
import { PAYMENT_STATUSES } from '../payments/types.js';
import type { PaymentProvider, ProviderPaymentStatus, ProviderRegistration, ProviderResult, ProviderStatusReader } from './types.js';

export interface ProviderClientOptions {
  baseUrl: string; // e.g. http://localhost:4000/mock-provider
  timeoutMs: number; // per attempt, enforced with AbortController
  maxAttempts?: number; // total tries per call, including the first (default 3)
  baseDelayMs?: number; // backoff base (default 200)
  maxDelayMs?: number; // backoff cap (default 2000)
  random?: () => number; // injectable so tests get exact delays
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

type Attempt =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string };

// statuses worth retrying: the request may simply not have been handled. 4xx answers are final.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const providerPaymentSchema = z.object({
  providerPaymentId: z.string().min(1),
  reference: z.string().min(1),
  amountPaise: z.number().int().positive(),
  status: z.enum(PAYMENT_STATUSES),
});

/** exponential backoff with full jitter: a random delay in [0, min(cap, base * 2^(attempt-1))) */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  return Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
}

/**
 * HTTP client for the (mock) payment provider. Both calls are safe to repeat: status reads have no
 * side effects and registration is idempotent by reference, so both are retried. Non-idempotent
 * calls must not go through `callWithRetry`.
 */
export function createProviderClient(options: ProviderClientOptions): PaymentProvider & ProviderStatusReader {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchFn = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function attemptOnce(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text(); // still covered by the abort signal
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { kind: 'response', status: res.status, body: parsed };
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'network', message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function callWithRetry(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ last: Attempt; attempts: number }> {
    for (let attempt = 1; ; attempt++) {
      const last = await attemptOnce(method, path, body);
      const retryable = last.kind !== 'response' || RETRYABLE_STATUSES.has(last.status);
      if (!retryable || attempt >= maxAttempts) return { last, attempts: attempt };
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
    }
  }

  /** maps a non-success attempt to the typed result. A timeout stays a timeout: outcome unknown. */
  function failure<T>(last: Attempt, attempts: number): ProviderResult<T> {
    const tries = `after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
    if (last.kind === 'timeout') return { kind: 'timeout', message: `no response within ${options.timeoutMs}ms ${tries}` };
    if (last.kind === 'network') return { kind: 'error', message: `network error ${tries}: ${last.message}` };
    return { kind: 'error', message: `provider answered HTTP ${last.status} ${tries}` };
  }

  return {
    async registerPayment({ reference, amountPaise }): Promise<ProviderResult<ProviderRegistration>> {
      const { last, attempts } = await callWithRetry('POST', '/payments', { reference, amountPaise });
      if (last.kind === 'response' && (last.status === 200 || last.status === 201)) {
        const parsed = providerPaymentSchema.safeParse(last.body);
        if (!parsed.success) return { kind: 'error', message: 'provider returned an unexpected response body' };
        return { kind: 'ok', value: { providerPaymentId: parsed.data.providerPaymentId } };
      }
      return failure(last, attempts);
    },

    async getPayment(reference): Promise<ProviderResult<ProviderPaymentStatus | null>> {
      const { last, attempts } = await callWithRetry('GET', `/payments/${encodeURIComponent(reference)}`);
      if (last.kind === 'response' && last.status === 404) return { kind: 'ok', value: null };
      if (last.kind === 'response' && last.status === 200) {
        const parsed = providerPaymentSchema.safeParse(last.body);
        if (!parsed.success) return { kind: 'error', message: 'provider returned an unexpected response body' };
        return { kind: 'ok', value: parsed.data };
      }
      return failure(last, attempts);
    },
  };
}
