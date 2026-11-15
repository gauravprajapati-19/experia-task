import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

export function signPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** constant-time compare; lengths are checked first because timingSafeEqual throws on a mismatch */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !SIGNATURE_PATTERN.test(signature)) return false;
  const expected = Buffer.from(signPayload(rawBody, secret), 'hex');
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
