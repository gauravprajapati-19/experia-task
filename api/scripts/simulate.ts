/**
 * `npm run simulate`: drives the RUNNING API (`npm run dev`, seeded with `npm run seed`) through the
 * webhook and reliability scenarios from CLAUDE.md section 9, printing each step and checking the
 * result against the database. Exit code 1 if any scenario fails.
 */
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { signPayload } from '../src/lib/hmac.js';
import { banner, bold, check, dim, formatPaise, green, heading, note, printDatabaseTotals, red, step, table } from './lib/report.js';

const API = (process.env.SIMULATE_API_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, '');
const PROVIDER = `${API}/mock-provider`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface HttpResult {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

async function http(method: string, url: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

interface Payment {
  id: string;
  reference: string;
  amountPaise: number;
  status: string;
  providerPaymentId: string | null;
  needsReconciliation: boolean;
  lastProviderError: string | null;
}

async function login(email: string): Promise<string> {
  const res = await http('POST', `${API}/api/auth/login`, { body: { email, password: process.env.SEED_DEMO_PASSWORD } });
  if (res.status !== 200) throw new Error(`login as ${email} failed (HTTP ${res.status}). Did you run \`npm run seed\`?`);
  return res.body.token as string;
}

async function createPayment(token: string, amountPaise: number, description: string, key = randomUUID()) {
  const res = await http('POST', `${API}/api/payments`, { token, body: { amountPaise, description }, headers: { 'Idempotency-Key': key } });
  return { res, payment: res.body.payment as Payment, key };
}

type WebhookStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

function event(payment: Payment, status: WebhookStatus, occurredAt = new Date()) {
  return {
    eventId: `evt_sim_${ulid()}`,
    paymentReference: payment.reference,
    status,
    providerPaymentId: payment.providerPaymentId ?? undefined,
    occurredAt: occurredAt.toISOString(),
  };
}

/** sends a webhook exactly like the provider: HMAC-SHA256 over the raw bytes */
async function sendWebhook(body: object, signature: string | null = 'valid'): Promise<HttpResult> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-provider-signature'] = signature === 'valid' ? signPayload(raw, config.PROVIDER_WEBHOOK_SECRET) : signature;
  const res = await fetch(`${API}/api/webhooks/payment-provider`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function describeResponse(res: HttpResult): string {
  const b = res.body;
  if (b.duplicate === true) return 'duplicate (ignored)';
  if (b.applied === true) return green(`applied -> ${String(b.status)}`);
  if (b.reason === 'STALE_EVENT') return 'stale (ignored)';
  const error = b.error as { code?: string } | undefined;
  return error?.code ?? JSON.stringify(b);
}

// database facts are the source of truth for every check

interface Facts {
  status: string;
  needsReconciliation: boolean;
  ledger: number;
  successAudit: number;
  auditSources: string;
  webhookEvents: number;
  duplicateDeliveries: number;
}

async function facts(paymentId: string): Promise<Facts> {
  const { rows } = await pool.query<Facts>(
    `SELECT p.status, p.needs_reconciliation AS "needsReconciliation",
            (SELECT count(*)::int FROM ledger_entries l WHERE l.payment_id = p.id) AS ledger,
            (SELECT count(*)::int FROM payment_audit_log a WHERE a.payment_id = p.id AND a.to_status = 'SUCCESS') AS "successAudit",
            (SELECT string_agg(a.source, ',' ORDER BY a.id) FROM payment_audit_log a WHERE a.payment_id = p.id) AS "auditSources",
            (SELECT count(*)::int FROM webhook_events w WHERE w.payment_id = p.id) AS "webhookEvents",
            (SELECT coalesce(sum(w.duplicate_deliveries), 0)::int FROM webhook_events w WHERE w.payment_id = p.id) AS "duplicateDeliveries"
     FROM payments p WHERE p.id = $1`,
    [paymentId],
  );
  return rows[0]!;
}

function showFacts(f: Facts): void {
  note(`DB: status=${f.status}  ledger_entries=${f.ledger}  SUCCESS audit rows=${f.successAudit}  webhook_events=${f.webhookEvents}  duplicate_deliveries=${f.duplicateDeliveries}  needs_reconciliation=${f.needsReconciliation}`);
}

const tracked: { label: string; payment: Payment }[] = [];
const track = (label: string, payment: Payment) => tracked.push({ label, payment });

interface Context {
  merchant: string;
  admin: string;
}

async function scenarioCreate(ctx: Context): Promise<boolean> {
  step(`POST /api/payments as merchant.a@experia.test (Nova Retail), amount ${formatPaise(49_900)}`);
  const { res, payment, key } = await createPayment(ctx.merchant, 49_900, 'Simulator: order #1');
  note(`HTTP ${res.status}  reference=${payment.reference}  provider id=${payment.providerPaymentId ?? '-'}`);
  track('1. created', payment);

  step('Same request again with the same Idempotency-Key');
  const replay = await createPayment(ctx.merchant, 49_900, 'Simulator: order #1', key);
  note(`HTTP ${replay.res.status}  Idempotent-Replayed: ${replay.res.headers.get('idempotent-replayed') ?? '-'}`);

  const ok = [
    check(res.status === 201 && payment.status === 'PENDING', '201 Created, status PENDING'),
    check(payment.providerPaymentId !== null, 'registered with the mock provider (provider id stored)'),
    check(replay.res.status === 200 && replay.payment.id === payment.id, 'replay returns 200 with the SAME payment (no second row)'),
  ];
  return ok.every(Boolean);
}

async function scenarioDuplicates(ctx: Context): Promise<{ passed: boolean; settled: Payment }> {
  const { payment: p1 } = await createPayment(ctx.merchant, 125_000, 'Simulator: duplicates (sequential)');
  track('2a. x5 sequential', p1);
  const e1 = event(p1, 'SUCCESS');
  step(`Same SUCCESS event ${e1.eventId} sent 5 times SEQUENTIALLY for ${p1.reference}`);
  const sequential: HttpResult[] = [];
  for (let i = 0; i < 5; i++) sequential.push(await sendWebhook(e1));
  sequential.forEach((r, i) => note(`#${i + 1} HTTP ${r.status}  ${describeResponse(r)}`));
  const f1 = await facts(p1.id);
  showFacts(f1);
  const seqOk = [
    check(sequential.filter((r) => r.body.applied === true).length === 1 && sequential.filter((r) => r.body.duplicate === true).length === 4, '1 applied, 4 duplicates'),
    check(f1.status === 'SUCCESS' && f1.ledger === 1 && f1.successAudit === 1, 'status changed once: 1 ledger entry, 1 SUCCESS audit row'),
    check(f1.webhookEvents === 1 && f1.duplicateDeliveries === 4, '1 stored event, 4 repeat deliveries counted on it'),
  ];

  const { payment: p2 } = await createPayment(ctx.merchant, 87_500, 'Simulator: duplicates (concurrent)');
  track('2b. x5 concurrent', p2);
  const e2 = event(p2, 'SUCCESS');
  step(`Same SUCCESS event ${e2.eventId} sent 5 times CONCURRENTLY (Promise.all) for ${p2.reference}`);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(e2)));
  concurrent.forEach((r, i) => note(`#${i + 1} HTTP ${r.status}  ${describeResponse(r)}`));
  const f2 = await facts(p2.id);
  showFacts(f2);
  const conOk = [
    check(concurrent.filter((r) => r.body.applied === true).length === 1, 'exactly 1 applied (the rest duplicate/stale)'),
    check(f2.status === 'SUCCESS' && f2.ledger === 1 && f2.successAudit === 1, 'money moved once: 1 ledger entry, 1 SUCCESS audit row'),
    check(f2.webhookEvents === 1 && f2.duplicateDeliveries === 4, '1 stored event, 4 repeat deliveries counted on it'),
  ];
  return { passed: [...seqOk, ...conOk].every(Boolean), settled: p1 };
}

async function scenarioLatePending(settled: Payment): Promise<boolean> {
  step(`Late PENDING event (occurred 2 minutes ago) for ${settled.reference}, which is already SUCCESS`);
  const res = await sendWebhook(event(settled, 'PENDING', new Date(Date.now() - 120_000)));
  note(`HTTP ${res.status}  ${describeResponse(res)}`);
  const f = await facts(settled.id);
  showFacts(f);
  return [
    check(res.status === 200 && res.body.reason === 'STALE_EVENT', '200 with reason STALE_EVENT'),
    check(f.status === 'SUCCESS' && f.ledger === 1, 'status still SUCCESS, still 1 ledger entry'),
  ].every(Boolean);
}

async function scenarioInvalidTransition(ctx: Context): Promise<boolean> {
  const { payment } = await createPayment(ctx.merchant, 32_000, 'Simulator: contradictory events');
  track('4. FAILED then SUCCESS', payment);
  step(`FAILED event for ${payment.reference}`);
  const failed = await sendWebhook(event(payment, 'FAILED'));
  note(`HTTP ${failed.status}  ${describeResponse(failed)}`);
  step('SUCCESS event for the same payment (contradicts a final status)');
  const success = await sendWebhook(event(payment, 'SUCCESS'));
  note(`HTTP ${success.status}  ${describeResponse(success)}`);
  const f = await facts(payment.id);
  showFacts(f);
  return [
    check(failed.status === 200 && success.status === 409, 'FAILED applied (200), SUCCESS rejected with 409 INVALID_STATUS_TRANSITION'),
    check(f.status === 'FAILED' && f.ledger === 0 && f.needsReconciliation, 'stays FAILED, no ledger entry, flagged for reconciliation'),
  ].every(Boolean);
}

async function scenarioBadSignature(ctx: Context): Promise<boolean> {
  const { payment } = await createPayment(ctx.merchant, 15_000, 'Simulator: forged webhook');
  const forged = event(payment, 'SUCCESS');
  step('SUCCESS webhook signed with the WRONG secret');
  const wrong = await sendWebhook(forged, signPayload(JSON.stringify(forged), 'an-attacker-guessing-the-secret-000000'));
  note(`HTTP ${wrong.status}  ${describeResponse(wrong)}`);
  step('Same webhook with NO signature header');
  const missing = await sendWebhook(forged, null);
  note(`HTTP ${missing.status}  ${describeResponse(missing)}`);
  const stored = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_events WHERE provider_event_id = $1', [forged.eventId]);
  const f = await facts(payment.id);
  showFacts(f);
  return [
    check(wrong.status === 401 && missing.status === 401, 'both rejected with 401 INVALID_SIGNATURE'),
    check(stored.rows[0]!.n === 0 && f.status === 'PENDING', 'nothing stored, payment still PENDING'),
  ].every(Boolean);
}

async function scenarioDelayed(ctx: Context): Promise<boolean> {
  const { payment } = await createPayment(ctx.merchant, 64_900, 'Simulator: slow provider');
  track('6. delayed webhook', payment);
  step(`Provider settles ${payment.reference} as SUCCESS but delivers the webhook 3 s later`);
  const settle = await http('POST', `${PROVIDER}/payments/${payment.reference}/settle`, { body: { status: 'SUCCESS', webhookDelayMs: 3_000 } });
  note(`mock provider answered HTTP ${settle.status} (accepted, delivery scheduled)`);
  const before = await facts(payment.id);
  note(`right after: status=${before.status}`);

  const started = Date.now();
  let after = before;
  while (after.status === 'PENDING' && Date.now() - started < 20_000) {
    await sleep(500);
    after = await facts(payment.id);
  }
  note(`webhook arrived after ~${((Date.now() - started) / 1000).toFixed(1)} s`);
  showFacts(after);
  return [
    check(settle.status === 202 && before.status === 'PENDING', 'still PENDING while the webhook is in flight'),
    check(after.status === 'SUCCESS' && after.ledger === 1, 'delayed webhook applied: SUCCESS, 1 ledger entry'),
  ].every(Boolean);
}

async function scenarioTimeoutAndReconcile(ctx: Context): Promise<boolean> {
  const original = (await http('GET', `${PROVIDER}/control`)).body;
  let created: Awaited<ReturnType<typeof createPayment>>;
  step('Force the mock provider to stop answering (timeout rate = 1)');
  await http('POST', `${PROVIDER}/control`, { body: { timeoutRate: 1 } });
  try {
    step(`POST /api/payments: the provider client gives up after ${config.PROVIDER_TIMEOUT_MS} ms per attempt, 3 attempts`);
    const started = Date.now();
    created = await createPayment(ctx.merchant, 210_000, 'Simulator: provider timeout');
    note(`HTTP ${created.res.status} after ${((Date.now() - started) / 1000).toFixed(1)} s  last_provider_error="${created.payment.lastProviderError ?? '-'}"`);
  } finally {
    await http('POST', `${PROVIDER}/control`, { body: original }); // always restore normal behaviour
    note('mock provider restored to normal behaviour');
  }
  const { payment } = created;
  track('7. timeout -> reconcile', payment);
  const afterCreate = await facts(payment.id);
  showFacts(afterCreate);
  const createOk = check(
    created.res.status === 201 && afterCreate.status === 'PENDING' && afterCreate.needsReconciliation,
    'timeout is "unknown", not failure: 201, stays PENDING, needs_reconciliation = true',
  );

  step('The provider did receive it (only the response was lost); it now settles SUCCESS but the webhook is lost');
  const providerView = await http('GET', `${PROVIDER}/payments/${payment.reference}`);
  note(`provider has the payment: HTTP ${providerView.status}, status ${String(providerView.body.status)}`);
  await http('POST', `${PROVIDER}/payments/${payment.reference}/settle`, { body: { status: 'SUCCESS', sendWebhook: false } });

  step('POST /api/admin/reconcile as admin@experia.test');
  const run = await http('POST', `${API}/api/admin/reconcile`, { token: ctx.admin, body: {} });
  const resolved = (run.body.resolved ?? []) as { reference: string; from: string; to: string }[];
  note(
    `run ${String(run.body.runId)}: checked ${String(run.body.checked)}, resolved ${resolved.length}, ` +
      `mismatches ${(run.body.mismatches as unknown[] | undefined)?.length ?? 0}, unresolved ${(run.body.unresolved as unknown[] | undefined)?.length ?? 0}`,
  );
  const mine = resolved.find((r) => r.reference === payment.reference);
  note(`this payment: ${mine ? `${mine.from} -> ${mine.to}` : 'not resolved'}`);
  const afterRun = await facts(payment.id);
  showFacts(afterRun);

  step('Run reconciliation again (must change nothing)');
  const rerun = await http('POST', `${API}/api/admin/reconcile`, { token: ctx.admin, body: {} });
  const rerunResolved = (rerun.body.resolved ?? []) as { reference: string }[];
  const afterRerun = await facts(payment.id);
  showFacts(afterRerun);

  return [
    createOk,
    check(run.status === 200 && mine?.to === 'SUCCESS', 'reconciliation resolved it from the provider status: PENDING -> SUCCESS'),
    check(afterRun.ledger === 1 && afterRun.auditSources.endsWith('reconciliation') && !afterRun.needsReconciliation, '1 ledger entry, audit source "reconciliation", flag cleared'),
    check(!rerunResolved.some((r) => r.reference === payment.reference) && afterRerun.ledger === 1, 'second run: nothing to do, still 1 ledger entry'),
  ].every(Boolean);
}

async function main(): Promise<void> {
  banner('Experia360 webhook & reliability simulator', `API ${API}  |  ${new Date().toISOString()}`);

  const health = await http('GET', `${API}/api/health`).catch(() => null);
  if (!health || health.status !== 200) throw new Error(`API not reachable at ${API}. Start it with \`npm run dev\`.`);
  const ctx: Context = { merchant: await login('merchant.a@experia.test'), admin: await login('admin@experia.test') };
  step('API healthy; logged in as merchant.a@experia.test and admin@experia.test');

  const results: { scenario: string; passed: boolean }[] = [];
  async function run(title: string, fn: () => Promise<boolean>): Promise<void> {
    heading(title);
    let passed = false;
    try {
      passed = await fn();
    } catch (err) {
      check(false, `crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
    results.push({ scenario: title, passed });
  }

  let settled: Payment | null = null;
  await run('1. Create a payment as Merchant A', () => scenarioCreate(ctx));
  await run('2. Same SUCCESS webhook x5: sequential, then concurrent', async () => {
    const out = await scenarioDuplicates(ctx);
    settled = out.settled;
    return out.passed;
  });
  await run('3. Late PENDING after SUCCESS (out of order)', () => {
    if (!settled) throw new Error('scenario 2 did not produce a settled payment');
    return scenarioLatePending(settled);
  });
  await run('4. FAILED then SUCCESS (contradictory events)', () => scenarioInvalidTransition(ctx));
  await run('5. Bad / missing signature', () => scenarioBadSignature(ctx));
  await run('6. Delayed webhook delivery', () => scenarioDelayed(ctx));
  await run('7. Provider timeout on create -> reconciliation', () => scenarioTimeoutAndReconcile(ctx));

  heading('Summary');
  table(results.map((r) => ({ scenario: r.scenario, result: r.passed ? green('PASS') : red('FAIL') })));

  console.log(`\n  ${bold('Payments created by this run')} ${dim('(read from the database)')}`);
  const rows = [];
  for (const { label, payment } of tracked) {
    const f = await facts(payment.id);
    rows.push({ scenario: label, reference: payment.reference, status: f.status, 'ledger entries': f.ledger, 'webhook events': f.webhookEvents, duplicates: f.duplicateDeliveries, flagged: f.needsReconciliation });
  }
  table(rows);

  console.log(`\n  ${bold('Whole database')}`);
  await printDatabaseTotals();

  const passed = results.filter((r) => r.passed).length;
  const line = `${passed}/${results.length} scenarios passed`;
  console.log(`\n  ${passed === results.length ? green(bold(line)) : red(bold(line))}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(red(`\nSimulator stopped: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
