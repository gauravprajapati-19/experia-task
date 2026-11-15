import express, { Router } from 'express';
import type { AppConfig } from '../config.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError } from '../lib/errors.js';
import { verifySignature } from '../lib/hmac.js';
import { processWebhookEvent } from './processor.js';
import { webhookEventSchema } from './schema.js';

export const SIGNATURE_HEADER = 'x-provider-signature';

const invalidSignature = () => new AppError(401, 'INVALID_SIGNATURE', 'Missing or invalid webhook signature');

/** for logging only: the event id from an unverified body, if one can be read. Never the body itself. */
function eventIdForLog(raw: Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    const eventId = (parsed as { eventId?: unknown } | null)?.eventId;
    return typeof eventId === 'string' ? eventId.slice(0, 128) : undefined;
  } catch {
    return undefined;
  }
}

/** HMAC-authenticated, no JWT. Mounted before express.json() (see app.ts). */
export function createWebhookRouter(config: AppConfig): Router {
  const router = Router();

  router.post(
    '/payment-provider',
    express.raw({ type: 'application/json', limit: '100kb' }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Webhook body must be application/json');
      }
      const raw = req.body;

      // 1. Verify before anything else. A bad signature stores nothing and logs no body or header value.
      if (!verifySignature(raw, req.get(SIGNATURE_HEADER), config.PROVIDER_WEBHOOK_SECRET)) {
        req.log.warn({ eventId: eventIdForLog(raw) }, 'invalid signature');
        throw invalidSignature();
      }

      // 2. parse and validate only after verifying (422 if malformed)
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(422, 'VALIDATION_ERROR', 'Webhook body is not valid JSON');
      }
      const event = webhookEventSchema.parse(payload);

      // 3. Process in one transaction (the three duplicate guards live in the processor).
      const result = await processWebhookEvent(event, payload);
      req.log.info({ eventId: event.eventId, reference: event.paymentReference, outcome: result.kind }, 'webhook processed');

      switch (result.kind) {
        case 'duplicate':
          res.json({ received: true, duplicate: true });
          return;
        case 'applied':
          res.json({ received: true, applied: true, status: result.status });
          return;
        case 'stale':
          res.json({ received: true, applied: false, reason: 'STALE_EVENT' });
          return;
        case 'unknown_payment':
          throw new AppError(404, 'UNKNOWN_PAYMENT', 'No payment matches this paymentReference');
        case 'invalid_transition':
          throw new AppError(
            409,
            'INVALID_STATUS_TRANSITION',
            `Payment is already ${result.status}; it was flagged for reconciliation`,
          );
      }
    }),
  );

  return router;
}
