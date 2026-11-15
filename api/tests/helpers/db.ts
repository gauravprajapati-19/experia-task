import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../../src/db/pool.js';

export const TEST_PASSWORD = 'test-password-123';
// Low bcrypt cost keeps the suite fast; production hashes use cost 10+.
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

/** Empties every table. Never run against anything but the test database (enforced in vitest.config.ts). */
export async function resetDb(): Promise<void> {
  await pool.query(`TRUNCATE ledger_entries, payment_audit_log, webhook_events, payments,
    mock_provider_payments, reconciliation_runs, users, merchants RESTART IDENTITY CASCADE`);
}

export interface TestUser {
  id: string;
  email: string;
  role: 'admin' | 'merchant';
  merchantId: string | null;
}

export interface TestWorld {
  merchantA: { id: string; user: TestUser };
  merchantB: { id: string; user: TestUser };
  admin: TestUser;
}

/** Two merchants (each with one user) plus an admin, created in a single round trip. */
export async function createTestWorld(): Promise<TestWorld> {
  const merchantAId = randomUUID();
  const merchantBId = randomUUID();
  const users: TestUser[] = [
    { id: randomUUID(), email: 'merchant.a@test.local', role: 'merchant', merchantId: merchantAId },
    { id: randomUUID(), email: 'merchant.b@test.local', role: 'merchant', merchantId: merchantBId },
    { id: randomUUID(), email: 'admin@test.local', role: 'admin', merchantId: null },
  ];
  await pool.query(
    `WITH m AS (
       INSERT INTO merchants (id, name) VALUES ($1, 'Test Merchant A'), ($2, 'Test Merchant B')
     )
     INSERT INTO users (id, email, password_hash, role, merchant_id)
     SELECT * FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::uuid[])`,
    [
      merchantAId,
      merchantBId,
      users.map((u) => u.id),
      users.map((u) => u.email),
      users.map(() => TEST_PASSWORD_HASH),
      users.map((u) => u.role),
      users.map((u) => u.merchantId),
    ],
  );
  const [userA, userB, admin] = users as [TestUser, TestUser, TestUser];
  return { merchantA: { id: merchantAId, user: userA }, merchantB: { id: merchantBId, user: userB }, admin };
}

export interface InsertPaymentOptions {
  amountPaise?: number;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED';
  reference?: string;
  providerPaymentId?: string | null;
  createdAt?: Date;
}

/** Inserts a payment row directly (bypassing the API) for read-side tests. Returns its id and reference. */
export async function insertPayment(merchantId: string, options: InsertPaymentOptions = {}): Promise<{ id: string; reference: string }> {
  const reference = options.reference ?? `PAY_TEST_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const { rows } = await pool.query<{ id: string; reference: string }>(
    `INSERT INTO payments (merchant_id, reference, amount_paise, status, idempotency_key, request_hash,
                           provider_payment_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'test-hash', $6, COALESCE($7, now()), COALESCE($7, now()))
     RETURNING id, reference`,
    [
      merchantId,
      reference,
      options.amountPaise ?? 10_000,
      options.status ?? 'PENDING',
      `test-${randomUUID()}`,
      options.providerPaymentId ?? null,
      options.createdAt ?? null, // default to the database clock, like the app's own rows
    ],
  );
  return rows[0]!;
}
