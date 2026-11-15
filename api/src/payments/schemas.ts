import { z } from 'zod';
import { amountPaiseSchema } from '../domain/money.js';
import { PAYMENT_STATUSES } from './types.js';

export const createPaymentSchema = z.object({
  amountPaise: amountPaiseSchema,
  currency: z.literal('INR').default('INR'),
  description: z.string().trim().max(140).optional(),
  customerEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

// printable ASCII, no spaces: UUIDs, ULIDs and similar client-generated keys all fit
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;

export const listPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(PAYMENT_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  merchantId: z.uuid().optional(), // honoured for admins only (see resolveMerchantScope)
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const summaryQuerySchema = listPaymentsQuerySchema.pick({ merchantId: true });
