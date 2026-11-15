/**
 * seeds synthetic demo data (fictional merchants, users and payments).
 * Truncate-and-reseed, so it is safe to run repeatedly, and it refuses to run against anything
 * but a development database.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { ulid } from 'ulid';
import { config, PLACEHOLDER_PATTERN } from '../src/config.js';
import { isSameDatabase } from '../src/db/databaseIdentity.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { requestHash } from '../src/lib/hash.js';

type Status = 'PENDING' | 'SUCCESS' | 'FAILED';

interface SeedMerchant {
  id: string;
  name: string;
  userEmail: string;
  orderPrefix: string;
  items: string[];
}

interface SeedPayment {
  merchant: SeedMerchant;
  createdAt: Date;
  amountPaise: number;
  status: Status; // our internal status
  providerStatus: Status | null; // what the mock provider reports; null = provider has no record
  description: string;
  customerEmail: string;
  needsReconciliation?: boolean;
  lastProviderError?: string; // set when the create call to the provider failed / timed out
  rejectedWebhookStatus?: Status; // a later conflicting webhook that was rejected as invalid_transition
  scenario?: string;
}

const PAYMENTS_PER_MERCHANT = 40;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// deterministic PRNG (mulberry32) so every run produces the same shape of data
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertSafeToSeed(): string {
  if (config.NODE_ENV !== 'development') {
    throw new Error(`Seed only runs with NODE_ENV=development (got "${config.NODE_ENV}"): it truncates every table.`);
  }
  if (process.env.TEST_DATABASE_URL && isSameDatabase(process.env.TEST_DATABASE_URL, config.DATABASE_URL)) {
    throw new Error('DATABASE_URL points at the test database; refusing to seed.');
  }
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 8 || PLACEHOLDER_PATTERN.test(password)) {
    throw new Error('Set SEED_DEMO_PASSWORD in .env (at least 8 characters, not the placeholder).');
  }
  return password;
}

class SeedRows {
  payments: unknown[][] = [];
  audit: unknown[][] = [];
  ledger: unknown[][] = [];
  webhooks: unknown[][] = [];
  provider: unknown[][] = [];
  scenarios: { merchant: string; reference: string; scenario: string }[] = [];

  add(p: SeedPayment, random: () => number): void {
    const id = randomUUID();
    const reference = `PAY_${ulid(p.createdAt.getTime())}`;
    const providerPaymentId = p.providerStatus ? `prov_${ulid(p.createdAt.getTime() + 1)}` : null;
    // if the create call timed out we never learned the provider's id, even if the provider has the payment
    const knownProviderPaymentId = p.lastProviderError ? null : providerPaymentId;
    const settledAt = new Date(p.createdAt.getTime() + Math.round((0.5 + random() * 9.5) * MINUTE_MS));
    const isTerminal = p.status !== 'PENDING';
    const body = { amountPaise: p.amountPaise, currency: 'INR', description: p.description, customerEmail: p.customerEmail };

    this.payments.push([
      id, p.merchant.id, reference, p.amountPaise, 'INR', p.status, `seed-${randomUUID()}`, requestHash(body),
      knownProviderPaymentId, p.needsReconciliation ?? false, p.lastProviderError ?? null, p.description,
      p.customerEmail, p.createdAt, isTerminal ? settledAt : p.createdAt,
    ]);
    this.audit.push([id, null, 'PENDING', 'api', null, p.merchant.userEmail, 'payment created', p.createdAt]);

    if (isTerminal) {
      const eventId = `evt_${ulid(settledAt.getTime())}`;
      this.webhooks.push(webhookRow(eventId, reference, id, p.status, providerPaymentId, settledAt, 'applied'));
      this.audit.push([id, 'PENDING', p.status, 'webhook', eventId, 'payment-provider', null, settledAt]);
      if (p.status === 'SUCCESS') this.ledger.push([id, p.merchant.id, 'CAPTURE', p.amountPaise, settledAt]);
    }

    if (p.rejectedWebhookStatus) {
      const rejectedAt = new Date(settledAt.getTime() + 5 * MINUTE_MS);
      const eventId = `evt_${ulid(rejectedAt.getTime())}`;
      this.webhooks.push(webhookRow(eventId, reference, id, p.rejectedWebhookStatus, providerPaymentId, rejectedAt, 'invalid_transition'));
    }

    if (p.providerStatus && providerPaymentId) {
      const providerUpdatedAt = p.providerStatus === 'PENDING' ? p.createdAt : settledAt;
      this.provider.push([providerPaymentId, reference, p.amountPaise, p.providerStatus, providerUpdatedAt]);
    }

    if (p.scenario) this.scenarios.push({ merchant: p.merchant.name, reference, scenario: p.scenario });
  }
}

function webhookRow(
  eventId: string, reference: string, paymentId: string, status: Status,
  providerPaymentId: string | null, occurredAt: Date, outcome: string,
): unknown[] {
  const payload = { eventId, paymentReference: reference, status, providerPaymentId, occurredAt: occurredAt.toISOString() };
  return [eventId, reference, paymentId, status, occurredAt, occurredAt, JSON.stringify(payload), outcome];
}

function randomPayments(merchant: SeedMerchant, count: number, random: () => number, rows: SeedRows): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const roll = random();
    const status: Status = roll < 0.6 ? 'SUCCESS' : roll < 0.85 ? 'FAILED' : 'PENDING';
    // pending payments are recent (still in flight at the provider); settled ones span the last 30 days
    const ageMs = status === 'PENDING' ? (1 + random() * 47) * 60 * MINUTE_MS : (0.1 + random() * 29.8) * DAY_MS;
    const rupees = 99 + Math.floor(random() * 24_901);
    const paise = random() < 0.3 ? Math.floor(random() * 100) : 0;
    const item = merchant.items[Math.floor(random() * merchant.items.length)] ?? 'Order';

    rows.add(
      {
        merchant,
        createdAt: new Date(now - ageMs),
        amountPaise: rupees * 100 + paise,
        status,
        providerStatus: status,
        description: `${item} - order ${merchant.orderPrefix}-${1000 + i}`,
        customerEmail: `customer${Math.floor(random() * 900) + 100}@example.test`,
      },
      random,
    );
  }
}

/** deliberate cases so reconciliation has something to resolve, leave unresolved and flag */
function reconciliationScenarios(merchant: SeedMerchant, rows: SeedRows, random: () => number): number {
  const now = Date.now();
  const base = { merchant, customerEmail: 'reconcile.demo@example.test' };
  const scenarios: Omit<SeedPayment, 'merchant' | 'customerEmail'>[] = [
    {
      scenario: 'webhook lost; provider says SUCCESS -> reconciliation resolves',
      createdAt: new Date(now - 50 * MINUTE_MS), amountPaise: 249_900, status: 'PENDING', providerStatus: 'SUCCESS',
      description: 'Reconcile demo: webhook never arrived (provider SUCCESS)',
    },
    {
      scenario: 'webhook lost; provider says FAILED -> reconciliation resolves',
      createdAt: new Date(now - 45 * MINUTE_MS), amountPaise: 89_900, status: 'PENDING', providerStatus: 'FAILED',
      description: 'Reconcile demo: webhook never arrived (provider FAILED)',
    },
    {
      scenario: 'provider timed out on create; provider actually has SUCCESS -> resolves',
      createdAt: new Date(now - 40 * MINUTE_MS), amountPaise: 1_250_000, status: 'PENDING', providerStatus: 'SUCCESS',
      needsReconciliation: true, lastProviderError: 'provider request timed out after 3000 ms',
      description: 'Reconcile demo: provider timeout during create',
    },
    {
      scenario: 'provider has no record -> stays unresolved',
      createdAt: new Date(now - 35 * MINUTE_MS), amountPaise: 54_000, status: 'PENDING', providerStatus: null,
      needsReconciliation: true, lastProviderError: 'provider returned HTTP 503',
      description: 'Reconcile demo: provider unreachable during create',
    },
    {
      scenario: 'internal SUCCESS vs provider FAILED -> mismatch reported, not overwritten',
      createdAt: new Date(now - 3 * 60 * MINUTE_MS), amountPaise: 399_900, status: 'SUCCESS', providerStatus: 'FAILED',
      needsReconciliation: true, rejectedWebhookStatus: 'FAILED',
      description: 'Reconcile demo: conflicting provider outcome',
    },
  ];
  for (const scenario of scenarios) rows.add({ ...base, ...scenario }, random);
  return scenarios.length;
}

/** multi-row INSERT with bound parameters. Table and column names are constants in this file, never input. */
async function insertRows(client: pg.PoolClient, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const tuples = rows.map((row, r) => `(${row.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`);
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, rows.flat());
}

async function main(): Promise<void> {
  const demoPassword = assertSafeToSeed();
  const passwordHash = await bcrypt.hash(demoPassword, 10);
  const random = createRandom(20261115);

  const novaRetail: SeedMerchant = {
    id: randomUUID(), name: 'Nova Retail', userEmail: 'merchant.a@experia.test', orderPrefix: 'NR',
    items: ['Wireless earbuds', 'Cotton kurta', 'Running shoes', 'Desk lamp', 'Travel backpack', 'Smart watch'],
  };
  const orbitFoods: SeedMerchant = {
    id: randomUUID(), name: 'Orbit Foods', userEmail: 'merchant.b@experia.test', orderPrefix: 'OF',
    items: ['Family meal box', 'Weekly groceries', 'Organic fruit basket', 'Masala chai pack', 'Dinner for two'],
  };

  const rows = new SeedRows();
  const scenarioCount = reconciliationScenarios(novaRetail, rows, random);
  randomPayments(novaRetail, PAYMENTS_PER_MERCHANT - scenarioCount, random, rows);
  randomPayments(orbitFoods, PAYMENTS_PER_MERCHANT, random, rows);

  await withTransaction(async (client) => {
    await client.query(`TRUNCATE ledger_entries, payment_audit_log, webhook_events, payments,
      mock_provider_payments, reconciliation_runs, users, merchants RESTART IDENTITY CASCADE`);

    await insertRows(client, 'merchants', ['id', 'name'], [
      [novaRetail.id, novaRetail.name],
      [orbitFoods.id, orbitFoods.name],
    ]);
    await insertRows(client, 'users', ['id', 'email', 'password_hash', 'role', 'merchant_id'], [
      [randomUUID(), 'admin@experia.test', passwordHash, 'admin', null],
      [randomUUID(), novaRetail.userEmail, passwordHash, 'merchant', novaRetail.id],
      [randomUUID(), orbitFoods.userEmail, passwordHash, 'merchant', orbitFoods.id],
    ]);
    await insertRows(client, 'payments', [
      'id', 'merchant_id', 'reference', 'amount_paise', 'currency', 'status', 'idempotency_key', 'request_hash',
      'provider_payment_id', 'needs_reconciliation', 'last_provider_error', 'description', 'customer_email',
      'created_at', 'updated_at',
    ], rows.payments);
    await insertRows(client, 'payment_audit_log',
      ['payment_id', 'from_status', 'to_status', 'source', 'source_ref', 'actor', 'note', 'created_at'], rows.audit);
    await insertRows(client, 'ledger_entries', ['payment_id', 'merchant_id', 'entry_type', 'amount_paise', 'created_at'], rows.ledger);
    await insertRows(client, 'webhook_events', [
      'provider_event_id', 'payment_reference', 'payment_id', 'event_status', 'occurred_at', 'received_at', 'payload', 'outcome',
    ], rows.webhooks);
    await insertRows(client, 'mock_provider_payments',
      ['provider_payment_id', 'payment_reference', 'amount_paise', 'status', 'updated_at'], rows.provider);
  });

  const { rows: summary } = await pool.query<{ merchant: string; status: string; count: number }>(`
    SELECT m.name AS merchant, p.status, count(*)::int AS count
    FROM payments p JOIN merchants m ON m.id = p.merchant_id
    GROUP BY m.name, p.status ORDER BY m.name, p.status`);

  console.log('Seed complete (synthetic data only).\n');
  console.table(summary);
  console.log(`Ledger entries: ${rows.ledger.length}, webhook events: ${rows.webhooks.length}, provider records: ${rows.provider.length}\n`);
  console.log('Reconciliation demo payments (Nova Retail):');
  console.table(rows.scenarios.map(({ reference, scenario }) => ({ reference, scenario })));
  console.log('Demo users: admin@experia.test, merchant.a@experia.test, merchant.b@experia.test (password = SEED_DEMO_PASSWORD)');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
