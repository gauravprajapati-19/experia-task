import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { createAdminRouter } from './admin/routes.js';
import { createAuthRouter } from './auth/routes.js';
import { config as defaultConfig, type AppConfig } from './config.js';
import { healthRouter } from './health/routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { httpLogger } from './middleware/httpLogger.js';
import { requestId } from './middleware/requestId.js';
import { createPaymentsRouter } from './payments/routes.js';
import { createMockProviderRouter, type MockProviderOptions } from './provider/mockProviderRouter.js';
import { createProviderClient } from './provider/providerClient.js';
import type { PaymentProvider, ProviderStatusReader } from './provider/types.js';
import { createWebhookRouter } from './webhooks/routes.js';

export interface AppDeps {
  /** `null` skips provider registration */
  provider?: PaymentProvider | null;
  statusReader?: ProviderStatusReader;
  /** tests inject deterministic provider behaviour and the webhook target */
  mockProvider?: Partial<MockProviderOptions>;
}

/** builds the Express app without listening, so tests can drive it directly */
export function createApp(config: AppConfig = defaultConfig, deps: AppDeps = {}): Express {
  const app = express();
  const providerClient = createProviderClient({ baseUrl: config.PROVIDER_BASE_URL, timeoutMs: config.PROVIDER_TIMEOUT_MS });

  app.disable('x-powered-by');
  // the Next.js dev proxy forwards from localhost; trust only loopback so rate limiting sees the real client IP
  app.set('trust proxy', 'loopback');

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  // allow-list: other origins get no CORS headers at all
  app.use(cors({ origin: [config.WEB_ORIGIN], credentials: true }));

  // raw body + HMAC: must be mounted BEFORE express.json(), which would consume the bytes being verified
  app.use('/api/webhooks', createWebhookRouter(config));

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/health', healthRouter);
  app.use('/api/auth', createAuthRouter(config));
  app.use('/api/admin', createAdminRouter(config, { statusReader: deps.statusReader ?? providerClient }));
  app.use('/api/payments', createPaymentsRouter(config, { provider: deps.provider === undefined ? providerClient : deps.provider }));

  if (config.MOCK_PROVIDER_ENABLED) {
    app.use(
      '/mock-provider',
      createMockProviderRouter({
        delayMs: config.MOCK_PROVIDER_DELAY_MS,
        timeoutRate: config.MOCK_PROVIDER_TIMEOUT_RATE,
        errorRate: config.MOCK_PROVIDER_ERROR_RATE,
        webhookSecret: config.PROVIDER_WEBHOOK_SECRET,
        webhookUrl: () => config.MOCK_PROVIDER_WEBHOOK_URL,
        ...deps.mockProvider,
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
