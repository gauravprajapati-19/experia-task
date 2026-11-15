import { describe, expect, it } from 'vitest';
import { backoffDelay, createProviderClient, type ProviderClientOptions } from '../src/provider/providerClient.js';

// Unit tests with a fake fetch: no network, no randomness (random and sleep are injected).

const PROVIDER_PAYMENT = { providerPaymentId: 'prov_1', reference: 'PAY_1', amountPaise: 1_000, status: 'SUCCESS' };

type FakeResponse = { status: number; body?: unknown } | 'hang' | 'network-error';

function fakeProvider(responses: FakeResponse[], overrides: Partial<ProviderClientOptions> = {}) {
  const calls: { url: string; method: string }[] = [];
  const sleeps: number[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET' });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    if (next === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return Promise.resolve(new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status }));
  }) as typeof fetch;

  const client = createProviderClient({
    baseUrl: 'http://provider.test/mock-provider/',
    timeoutMs: 20,
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    fetch: fetchFn,
    ...overrides,
  });
  return { client, calls, sleeps };
}

describe('provider client: retries', () => {
  it('retries a 503 with exponential backoff + full jitter, then succeeds', async () => {
    const { client, calls, sleeps } = fakeProvider([{ status: 503 }, { status: 503 }, { status: 200, body: PROVIDER_PAYMENT }]);
    expect(await client.getPayment('PAY_1')).toEqual({ kind: 'ok', value: PROVIDER_PAYMENT });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ url: 'http://provider.test/mock-provider/payments/PAY_1', method: 'GET' });
    expect(sleeps).toEqual([100, 200]); // random 0.5 x min(2000, 200 * 2^(n-1))
  });

  it('gives up after 3 attempts and reports an error (not a timeout) for repeated 503s', async () => {
    const { client, calls } = fakeProvider([{ status: 503 }]);
    expect(await client.getPayment('PAY_1')).toEqual({ kind: 'error', message: 'provider answered HTTP 503 after 3 attempts' });
    expect(calls).toHaveLength(3);
  });

  it('reports a timeout as kind "timeout" (outcome unknown) after retrying', async () => {
    const { client, calls } = fakeProvider(['hang']);
    expect(await client.registerPayment({ reference: 'PAY_1', amountPaise: 1_000 })).toEqual({
      kind: 'timeout',
      message: 'no response within 20ms after 3 attempts',
    });
    expect(calls).toHaveLength(3);
  });

  it('retries network errors', async () => {
    const { client, calls } = fakeProvider(['network-error', { status: 201, body: PROVIDER_PAYMENT }]);
    expect(await client.registerPayment({ reference: 'PAY_1', amountPaise: 1_000 })).toEqual({ kind: 'ok', value: { providerPaymentId: 'prov_1' } });
    expect(calls).toHaveLength(2);
  });

  it('does not retry final 4xx answers', async () => {
    const notFound = fakeProvider([{ status: 404 }]);
    expect(await notFound.client.getPayment('PAY_X')).toEqual({ kind: 'ok', value: null });
    expect(notFound.calls).toHaveLength(1);

    const conflict = fakeProvider([{ status: 409 }]);
    expect(await conflict.client.registerPayment({ reference: 'PAY_1', amountPaise: 1 })).toEqual({
      kind: 'error',
      message: 'provider answered HTTP 409 after 1 attempt',
    });
    expect(conflict.calls).toHaveLength(1);
  });

  it('treats an unexpected response body as an error', async () => {
    const { client } = fakeProvider([{ status: 200, body: { status: 'DONE' } }]);
    expect(await client.getPayment('PAY_1')).toEqual({ kind: 'error', message: 'provider returned an unexpected response body' });
  });

  it('URL-encodes the reference', async () => {
    const { client, calls } = fakeProvider([{ status: 404 }]);
    await client.getPayment('a/b?c');
    expect(calls[0]!.url).toBe('http://provider.test/mock-provider/payments/a%2Fb%3Fc');
  });
});

describe('backoffDelay (full jitter)', () => {
  it('grows exponentially and is capped', () => {
    const max = () => 0.999_999;
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, 200, 2000, max))).toEqual([199, 399, 799, 1599, 1999]);
    expect(backoffDelay(3, 200, 2000, () => 0)).toBe(0);
  });
});
