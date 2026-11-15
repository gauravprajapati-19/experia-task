import { signPayload } from '../lib/hmac.js';
import type { WebhookEvent } from '../webhooks/schema.js';

export interface DeliveryResult {
  status: number; // 0 when the request itself failed
  body: unknown;
}

/** sends one provider event, signed over the exact bytes in the request body */
export async function deliverWebhook(url: string, secret: string, event: WebhookEvent): Promise<DeliveryResult> {
  const raw = JSON.stringify(event);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': signPayload(raw, secret) },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : 'delivery failed' } };
  }
}
