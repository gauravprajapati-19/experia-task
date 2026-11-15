import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config, loadConfig } from '../src/config.js';
import { isSameDatabase } from '../src/db/databaseIdentity.js';
import { canonicalJson, requestHash } from '../src/lib/hash.js';
import { createLogger } from '../src/lib/logger.js';

const app = createApp(config);

describe('health and error shape', () => {
  it('GET /api/health reports the database is reachable', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true, db: true });
  });

  it('unknown routes return 404 in the standard error shape', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route GET /api/nope not found' } });
  });

  it('sets security headers and a request id', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('only allows CORS from WEB_ORIGIN', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', config.WEB_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(config.WEB_ORIGIN);
    const other = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('config validation', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost/db',
    JWT_SECRET: 'a'.repeat(40),
    PROVIDER_WEBHOOK_SECRET: 'b'.repeat(40),
  };

  it('accepts a valid environment and applies defaults', () => {
    const parsed = loadConfig(base);
    expect(parsed.PORT).toBe(4000);
    expect(parsed.PROVIDER_TIMEOUT_MS).toBe(3000);
    expect(parsed.MOCK_PROVIDER_ENABLED).toBe(true);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET must be at least 32 characters/);
  });

  it('refuses placeholder secrets outside NODE_ENV=test, without echoing the value', () => {
    const placeholder = 'replace-me-with-a-random-string-of-at-least-32-characters';
    let message = '';
    try {
      loadConfig({ ...base, PROVIDER_WEBHOOK_SECRET: placeholder });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/PROVIDER_WEBHOOK_SECRET still has the placeholder value/);
    expect(message).not.toContain(placeholder);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: placeholder })).toThrow();
  });

  it('allows placeholder secrets under NODE_ENV=test', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', JWT_SECRET: 'replace-me-' + 'x'.repeat(30) })).not.toThrow();
  });
});

describe('logger redaction', () => {
  it('redacts auth headers, cookies, webhook signatures and secret-like fields', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = createLogger('info', sink);
    log.info({
      req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'session=xyz', 'x-provider-signature': 'deadbeef' } },
      body: { password: 'hunter2', token: 'tok', secret: 'sss' },
    });

    const output = lines.join('');
    for (const leaked of ['abc.def.ghi', 'session=xyz', 'deadbeef', 'hunter2', '"tok"', 'sss']) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain('[REDACTED]');
  });
});

describe('canonical request hash', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(requestHash({ amountPaise: 100, currency: 'INR' })).toBe(requestHash({ currency: 'INR', amountPaise: 100 }));
    expect(requestHash({ amountPaise: 100 })).not.toBe(requestHash({ amountPaise: 101 }));
  });
});

describe('test database guard', () => {
  it('treats pooled and direct Neon hosts, and different params, as the same database', () => {
    const direct = 'postgresql://u:p@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const pooled = 'postgresql://u2:p2@ep-cool-1-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full';
    expect(isSameDatabase(direct, pooled)).toBe(true);
    expect(isSameDatabase(direct, direct.replace('/neondb', '/neondb_test'))).toBe(false);
    expect(isSameDatabase('postgresql://a@localhost:5432/experia', 'postgresql://a@localhost/experia_test')).toBe(false);
  });
});

describe('mock provider safety', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://localhost/db',
    JWT_SECRET: 'a'.repeat(40),
    PROVIDER_WEBHOOK_SECRET: 'b'.repeat(40),
  };

  it('refuses to start in production with the unauthenticated mock provider enabled', () => {
    expect(() => loadConfig(base)).toThrow(/MOCK_PROVIDER_ENABLED must be false in production/);
    expect(() => loadConfig({ ...base, MOCK_PROVIDER_ENABLED: 'false' })).not.toThrow();
  });
});
