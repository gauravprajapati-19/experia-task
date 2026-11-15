import { Router } from 'express';
import { z } from 'zod';
import { resolveMerchantScope } from '../auth/merchantScope.js';
import { createRequireAuth, getAuth, requireRole } from '../auth/middleware.js';
import type { AppConfig } from '../config.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError, notFound } from '../lib/errors.js';
import type { PaymentProvider } from '../provider/types.js';
import { findPayment, getAuditTimeline, getPaymentSummary, getWebhookEvents, listPayments } from './queries.js';
import { createPaymentSchema, IDEMPOTENCY_KEY_PATTERN, listPaymentsQuerySchema, summaryQuerySchema } from './schemas.js';
import { createPayment } from './service.js';
import { toPaymentDto } from './types.js';

export interface PaymentsRouterDeps {
  provider: PaymentProvider | null;
}

const paymentIdSchema = z.uuid();
const paymentNotFound = () => notFound('Payment not found');

function readIdempotencyKey(header: string | undefined): string {
  if (!header) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 printable characters without spaces');
  }
  return header;
}

export function createPaymentsRouter(config: AppConfig, deps: PaymentsRouterDeps): Router {
  const router = Router();
  router.use(createRequireAuth(config.JWT_SECRET));

  // merchants only: an admin has no merchant to create a payment for (403)
  router.post(
    '/',
    requireRole('merchant'),
    asyncHandler(async (req, res) => {
      const idempotencyKey = readIdempotencyKey(req.get('idempotency-key'));
      const input = createPaymentSchema.parse(req.body);
      const auth = getAuth(req);
      const merchantId = resolveMerchantScope(auth) as string; // always set for merchant users

      const { payment, replayed } = await createPayment({ merchantId, userId: auth.userId, idempotencyKey, input }, deps.provider, req.log);
      if (replayed) res.set('Idempotent-Replayed', 'true');
      res.status(replayed ? 200 : 201).json({ payment: toPaymentDto(payment) });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = listPaymentsQuerySchema.parse(req.query);
      const merchantId = resolveMerchantScope(getAuth(req), query.merchantId);
      const { rows, total } = await listPayments({ merchantId, status: query.status, q: query.q }, query.page, query.pageSize);
      res.json({
        items: rows.map(toPaymentDto),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      });
    }),
  );

  // registered before '/:id' so "summary" is not read as a payment id
  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const query = summaryQuerySchema.parse(req.query);
      res.json(await getPaymentSummary(resolveMerchantScope(getAuth(req), query.merchantId)));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = paymentIdSchema.safeParse(req.params.id);
      if (!id.success) throw paymentNotFound();

      // another merchant's payment is reported exactly like a missing one, so existence is not leaked
      const payment = await findPayment(id.data, resolveMerchantScope(getAuth(req)));
      if (!payment) throw paymentNotFound();

      const [auditTimeline, webhookEvents] = await Promise.all([getAuditTimeline(payment.id), getWebhookEvents(payment.id)]);
      res.json({ payment: toPaymentDto(payment), auditTimeline, webhookEvents });
    }),
  );

  return router;
}
