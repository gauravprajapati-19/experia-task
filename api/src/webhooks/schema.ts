import { z } from 'zod';
import { PAYMENT_STATUSES } from '../payments/types.js';

export const webhookEventSchema = z.object({
  eventId: z.string().min(1).max(128),
  paymentReference: z.string().min(1).max(128),
  status: z.enum(PAYMENT_STATUSES),
  providerPaymentId: z.string().min(1).max(128).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;
