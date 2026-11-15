import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// repo-root .env; variables already set in the environment win
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/** values copied from .env.example that must never be used outside tests */
export const PLACEHOLDER_PATTERN = /replace-me|change-?me|placeholder/i;

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const probability = z.coerce.number().min(0).max(1);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    PROVIDER_WEBHOOK_SECRET: z.string().min(32, 'PROVIDER_WEBHOOK_SECRET must be at least 32 characters'),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    PROVIDER_BASE_URL: z.url().default('http://localhost:4000/mock-provider'),
    PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    MOCK_PROVIDER_ENABLED: booleanString.default(true),
    MOCK_PROVIDER_DELAY_MS: z.coerce.number().int().min(0).default(0),
    MOCK_PROVIDER_TIMEOUT_RATE: probability.default(0),
    MOCK_PROVIDER_ERROR_RATE: probability.default(0),
    MOCK_PROVIDER_WEBHOOK_URL: z.url().default('http://localhost:4000/api/webhooks/payment-provider'),
    LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.MOCK_PROVIDER_ENABLED) {
      // the simulator is unauthenticated and can trigger signed webhooks: never expose it in production
      ctx.addIssue({ code: 'custom', path: ['MOCK_PROVIDER_ENABLED'], message: 'MOCK_PROVIDER_ENABLED must be false in production' });
    }
    if (env.NODE_ENV === 'test') return;
    for (const key of ['JWT_SECRET', 'PROVIDER_WEBHOOK_SECRET'] as const) {
      if (PLACEHOLDER_PATTERN.test(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} still has the placeholder value from .env.example` });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

/** error messages name the variable but never echo its value */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // treat `KEY=` (empty) as unset so defaults apply
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const config = loadConfig();
