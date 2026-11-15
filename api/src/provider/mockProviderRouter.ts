import { type Request, type Response, Router } from 'express';
import { ulid } from 'ulid';
import { z } from 'zod';
import { amountPaiseSchema } from '../domain/money.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { PAYMENT_STATUSES } from '../payments/types.js';
import type { WebhookEvent } from '../webhooks/schema.js';
import { findProviderPayment, registerProviderPayment, setProviderStatus } from './mockProviderStore.js';
import { deliverWebhook, type DeliveryResult } from './webhookSender.js';

export interface MockProviderOptions {
  delayMs: number;
  timeoutRate: number; // 0-1: share of calls that never answer (the client must time out)
  errorRate: number; // 0-1: share of calls that answer 503
  webhookSecret: string;
  webhookUrl: () => string; // a function so tests can point it at a server started on a random port
  random?: () => number; // injectable for deterministic tests
  hangMs?: number; // how long a simulated timeout holds the request open
}

const registerSchema = z.object({
  reference: z.string().min(1).max(128),
  amountPaise: amountPaiseSchema,
});

const settleSchema = z.object({
  status: z.enum(PAYMENT_STATUSES),
  sendWebhook: z.boolean().default(true),
  webhookDelayMs: z.number().int().min(0).max(60_000).default(0),
  duplicates: z.number().int().min(1).max(10).default(1), // the SAME event (same eventId) sent n times
  concurrent: z.boolean().default(false), // send the duplicates in parallel instead of one after another
  eventId: z.string().min(1).max(128).optional(),
});

const controlSchema = z
  .object({
    delayMs: z.number().int().min(0).max(30_000),
    timeoutRate: z.number().min(0).max(1),
    errorRate: z.number().min(0).max(1),
  })
  .partial();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** resolves after `ms`, or as soon as the client gives up and closes the connection */
function holdOpen(res: Response, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref();
    res.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * simulated external payment provider, mounted at /mock-provider (not under /api).
 * Synthetic data only. Demo/test tool: it has no auth and must be disabled outside development.
 */
export function createMockProviderRouter(options: MockProviderOptions): Router {
  const router = Router();
  const random = options.random ?? Math.random;
  // mutable so the demo control endpoint can force failures on a running server
  const behaviour = { delayMs: options.delayMs, timeoutRate: options.timeoutRate, errorRate: options.errorRate };

  /**
   * applies the configured delay / timeout / error behaviour. Returns true if it already answered.
   * `beforeHang` runs before a simulated timeout: the provider did the work but the response is lost,
   * which is exactly why a client timeout must be treated as "unknown", never as "failed".
   */
  async function simulateConditions(req: Request, res: Response, beforeHang?: () => Promise<unknown>): Promise<boolean> {
    if (behaviour.delayMs > 0) await sleep(behaviour.delayMs);
    if (behaviour.timeoutRate > 0 && random() < behaviour.timeoutRate) {
      if (beforeHang) await beforeHang();
      await holdOpen(res, options.hangMs ?? 30_000);
      if (!res.headersSent && !req.destroyed) res.status(504).json({ error: { code: 'PROVIDER_TIMEOUT', message: 'Simulated timeout' } });
      return true;
    }
    if (behaviour.errorRate > 0 && random() < behaviour.errorRate) {
      res.status(503).json({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Simulated provider error' } });
      return true;
    }
    return false;
  }

  // demo control (used by scripts/simulate.ts): read or change the failure behaviour at runtime
  router.get('/control', (_req, res) => {
    res.json(behaviour);
  });
  router.post('/control', (req, res) => {
    Object.assign(behaviour, controlSchema.parse(req.body));
    res.json(behaviour);
  });

  router.post(
    '/payments',
    asyncHandler(async (req, res) => {
      const { reference, amountPaise } = registerSchema.parse(req.body);
      if (await simulateConditions(req, res, () => registerProviderPayment(reference, amountPaise))) return;
      const { payment, created } = await registerProviderPayment(reference, amountPaise);
      if (payment.amountPaise !== amountPaise) {
        throw new AppError(409, 'REFERENCE_CONFLICT', 'This reference is already registered with a different amount');
      }
      res.status(created ? 201 : 200).json(payment);
    }),
  );

  router.get(
    '/payments/:reference',
    asyncHandler(async (req, res) => {
      if (await simulateConditions(req, res)) return;
      const payment = await findProviderPayment(String(req.params.reference));
      if (!payment) throw notFound('Provider has no payment with this reference');
      res.json(payment);
    }),
  );

  // demo helper: the provider "decides" a payment, then (optionally) tells us via a signed webhook
  router.post(
    '/payments/:reference/settle',
    asyncHandler(async (req, res) => {
      const input = settleSchema.parse(req.body);
      const payment = await setProviderStatus(String(req.params.reference), input.status);
      if (!payment) throw notFound('Provider has no payment with this reference');
      if (!input.sendWebhook) {
        res.json({ payment, webhook: null });
        return;
      }

      const event: WebhookEvent = {
        eventId: input.eventId ?? `evt_${ulid()}`,
        paymentReference: payment.reference,
        status: input.status,
        providerPaymentId: payment.providerPaymentId,
        occurredAt: new Date().toISOString(),
      };
      const deliverAll = async (): Promise<DeliveryResult[]> => {
        const send = () => deliverWebhook(options.webhookUrl(), options.webhookSecret, event);
        if (input.concurrent) return Promise.all(Array.from({ length: input.duplicates }, send));
        const results: DeliveryResult[] = [];
        for (let i = 0; i < input.duplicates; i++) results.push(await send());
        return results;
      };

      if (input.webhookDelayMs === 0) {
        res.json({ payment, webhook: { eventId: event.eventId, deliveries: await deliverAll() } });
        return;
      }

      // delayed delivery: answer now, send later (simulates a slow provider)
      setTimeout(() => {
        deliverAll()
          .then((deliveries) => logger.info({ eventId: event.eventId, statuses: deliveries.map((d) => d.status) }, 'delayed webhook delivered'))
          .catch((err: unknown) => logger.error({ err, eventId: event.eventId }, 'delayed webhook failed'));
      }, input.webhookDelayMs);
      res.status(202).json({ payment, webhook: { eventId: event.eventId, scheduledInMs: input.webhookDelayMs } });
    }),
  );

  return router;
}
