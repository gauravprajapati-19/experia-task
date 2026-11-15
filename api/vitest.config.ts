import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';
import { isSameDatabase } from './src/db/databaseIdentity.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
if (process.env.DATABASE_URL && isSameDatabase(testDatabaseUrl, process.env.DATABASE_URL)) {
  throw new Error('TEST_DATABASE_URL must point at a different database than DATABASE_URL: the test suite truncates every table.');
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/closePool.ts'],
    fileParallelism: false, // every file shares one real database
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Fixed, test-only values: tests never depend on the developer's real secrets or random provider behaviour.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: 'test-only-jwt-secret-0123456789abcdefghijklmnop',
      PROVIDER_WEBHOOK_SECRET: 'test-only-webhook-secret-0123456789abcdefghij',
      LOGIN_RATE_LIMIT_PER_MIN: '1000',
      LOG_LEVEL: 'silent',
      MOCK_PROVIDER_DELAY_MS: '0',
      MOCK_PROVIDER_TIMEOUT_RATE: '0',
      MOCK_PROVIDER_ERROR_RATE: '0',
    },
  },
});
