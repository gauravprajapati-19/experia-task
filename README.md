# Experia360 — Secure Payment Webhook Processor & Merchant Dashboard

> **Reviewers:** start with [REVIEWER_SETUP.md](REVIEWER_SETUP.md). It covers running the project against the provided hosted database in about 10 minutes, with a list of things to check.

## Overview

A payment backend and merchant dashboard for the Experia360 technical assessment. Correctness and security come first.

- **Signed webhooks.** HMAC-SHA256 is checked over the raw request bytes. The same event sent 5 times, at once, late or out of order changes the payment at most once.
- **Idempotent payment creation.** An `Idempotency-Key` header and a unique constraint give one payment per key.
- **A strict state machine.** `PENDING → SUCCESS | FAILED`. Final states never change. Each change writes an append-only audit row, and a SUCCESS writes exactly one ledger entry.
- **A timeout means "unknown".** A provider timeout never marks a payment failed. Reconciliation settles it from the provider's records and reports conflicts instead of overwriting them.
- **Merchant isolation.** The merchant comes from the JWT on every query. Another merchant's payment returns 404.
- **A Next.js dashboard.** Summary cards, a transaction list with search, status filter and server-side pagination, and a details page with the audit timeline and webhook history. It works at phone width.

All data is synthetic: two fictional merchants (Nova Retail, Orbit Foods), a simulated provider, and no real credentials, customers or money.

## How I built this

I wrote the spec first (`CLAUDE.md`, kept in this repo) and built the project in phases with Claude Code as a pair programmer, reviewing each phase before moving on. These decisions were mine:

- the ledger insert lives inside `applyTransition`, so webhooks and reconciliation share one guard;
- a duplicate-delivery counter, so repeats are visible on the dashboard without being processed;
- 404 instead of 403 for another merchant's payment, and a provider timeout means "unknown", never "failed";
- the background queue stays a documented limitation rather than a rushed feature.

I verified the result with the test suite, `npm run simulate` and a run from a fresh clone.

## Tech stack

| Area | Choice |
| --- | --- |
| Runtime | Node.js 20.19+, npm workspaces (`api/`, `web/`) |
| API | Express 4, TypeScript (strict), `tsx` |
| Database | PostgreSQL 16 via `pg` with plain, parameterised SQL; `node-pg-migrate` SQL migrations |
| Validation / auth | zod 4 · JWT (`jsonwebtoken`) in an httpOnly cookie or Bearer header · bcryptjs |
| Security / logging | helmet · cors (allow-list) · express-rate-limit (login) · pino + pino-http with redaction |
| Tests | Vitest + Supertest against a real PostgreSQL test database |
| Dashboard | Next.js 15 (App Router), React 19, Tailwind CSS 4, TanStack Query 5, lucide-react |
| Bonus | `docker-compose.yml` (Postgres 16) · Postman collection · append-only DB triggers · `npm run simulate` |

## Architecture

```mermaid
flowchart LR
  user([Merchant / admin browser]) -->|httpOnly session cookie| web["Next.js dashboard :3000<br/>rewrites /api/* to the API"]
  web --> api["Express API :4000<br/>/api/*"]
  api -->|plain SQL, one transaction per webhook| db[("PostgreSQL 16<br/>payments, webhook_events,<br/>payment_audit_log, ledger_entries")]
  api -->|"providerClient: timeout + retries"| mock["Mock provider<br/>/mock-provider/* (simulated external service)"]
  mock -->|"signed webhook<br/>X-Provider-Signature: HMAC-SHA256"| api
  mock --- mockdb[("mock_provider_payments<br/>(the provider's own records)")]
  recon["Reconciliation<br/>npm run reconcile / POST /api/admin/reconcile"] -->|"GET provider status"| mock
  recon -->|applyTransition, source = reconciliation| db
```

- `api/src/app.ts` builds the app; `server.ts` only listens, and tests use `app.ts` directly.
- The webhook route is mounted with `express.raw()` **before** `express.json()`, so the signature is checked over the exact bytes received.
- The mock provider runs in the same process, but keeps its own table, so reconciliation genuinely compares two sources. It is mounted only when `MOCK_PROVIDER_ENABLED=true`, and the API refuses to start with it in production.
- `applyTransition` (`api/src/domain/applyTransition.ts`) is the **only** code that changes `payments.status`. Webhooks and reconciliation both go through it.

```
api/src/  auth/ payments/ webhooks/ domain/ provider/ reconciliation/ admin/ middleware/ db/ lib/
api/migrations/   api/scripts/ (seed, simulate, reconcile)   api/tests/
web/app/ (login, dashboard, payments/[id])   web/components/   web/lib/ (typed API client)
docs/ (api.http, postman_collection.json, test-results.txt, screenshots/)
```

## Setup

Prerequisites: **Node.js 20.19+** and npm. Use Docker for the database, or any PostgreSQL 16 you already have (local install or Neon).
The commands work in Git Bash, macOS/Linux shells and PowerShell.

### Option A: Docker (recommended for reviewers)

```bash
git clone https://github.com/gauravprajapati-19/experia-task.git experia-task
cd experia-task
npm install
cp .env.example .env
```

`npm install` ends with a deprecation notice for ESLint 9 and a few moderate `npm audit` advisories in development tooling. Both are expected (see [Limitations](#limitations--what-id-do-next)).

Edit `.env` and replace the three placeholders. Leave the database URLs as they are for Docker.

```bash
# run twice: once for JWT_SECRET, once for PROVIDER_WEBHOOK_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# SEED_DEMO_PASSWORD: any password you like for the three demo users (demo only)
```

Then:

```bash
npm run db:up        # postgres:16 on localhost:5432 (waits until healthy); creates the experia and experia_test databases
npm run migrate      # schema on the dev database
npm run seed         # synthetic demo data (safe to re-run; refuses to touch the test database)
npm run dev          # API on http://localhost:4000 + dashboard on http://localhost:3000
```

Open http://localhost:3000 and sign in with a [demo account](#demo-accounts). In development, the "Use demo account" buttons fill the credentials for you.

### Option B: any PostgreSQL (local install or Neon)

1. Create **two** empty databases: one for development, one for tests. The test suite truncates every table, so they must differ.
   - Local: `createdb experia && createdb experia_test`.
   - Neon: create two databases in your project.
2. `npm install` and `cp .env.example .env`, then set in `.env`:
   - `DATABASE_URL=postgresql://user:password@host:5432/experia`
   - `TEST_DATABASE_URL=postgresql://user:password@host:5432/experia_test`
   - the two secrets and `SEED_DEMO_PASSWORD`, as in Option A.
3. `npm run migrate`, `npm run seed`, `npm run dev`.

**Neon notes:**
- Use the **direct** connection string, with no `-pooler` in the host. Migrations take session-level advisory locks that a transaction pooler can break, and direct connections give the concurrency tests steadier latency.
- Write `?sslmode=verify-full` rather than `sslmode=require`. `pg` already treats `require` as `verify-full`, but prints a deprecation warning for it.

The test runner and the seed script both refuse to run if the two URLs point at the same database (pooled and direct hosts count as the same).

### Everyday commands

| Command | Does |
| --- | --- |
| `npm run dev` | API (4000, watch mode) + dashboard (3000) together |
| `npm test` | Migrates `TEST_DATABASE_URL`, then runs the whole API suite |
| `npm run test:report` | Same, verbose, written to [`docs/test-results.txt`](docs/test-results.txt) |
| `npm run simulate` | (API running) the 7 webhook and reliability scenarios, printed step by step with PASS/FAIL |
| `npm run reconcile` | (API running) reconciliation CLI; prints resolved / mismatches / unresolved tables |
| `npm run lint` / `npm run typecheck` | ESLint and `tsc --noEmit` for both workspaces |
| `npm run db:up` / `npm run db:down` | Start / stop the Docker database |
| `npm run migrate` / `npm run migrate:test` | Migrations on the dev / test database |
| `npm run seed` | Truncate and reseed demo data (dev database only) |

## Demo accounts

Created by `npm run seed`. All three use the password you set in `SEED_DEMO_PASSWORD` (demo only, never a real credential).

| Email | Role | Sees |
| --- | --- | --- |
| `merchant.a@experia.test` | merchant | Nova Retail's payments only; can create test payments |
| `merchant.b@experia.test` | merchant | Orbit Foods' payments only |
| `admin@experia.test` | admin | All merchants (merchant selector); reconciliation endpoints; cannot create payments |

The seed creates about 40 payments per merchant across all statuses over the last 30 days. Each has matching audit rows, ledger entries for SUCCESS, and provider records. A few deliberately unresolved and conflicting payments give reconciliation something to show.

## Environment variables

All in the repo-root `.env` (gitignored; only [`.env.example`](.env.example) with placeholders is committed). The API, the scripts, the tests and the dashboard all read this one file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables the Secure cookie flag and forbids the mock provider |
| `PORT` | `4000` | API port |
| `DATABASE_URL` / `TEST_DATABASE_URL` | Docker URLs in `.env.example` | Dev and test databases (must differ) |
| `JWT_SECRET` | none (required, ≥ 32 chars) | Signs session JWTs; placeholder values are refused outside tests |
| `PROVIDER_WEBHOOK_SECRET` | none (required, ≥ 32 chars) | HMAC-SHA256 key for `X-Provider-Signature` |
| `SEED_DEMO_PASSWORD` | none | Password for the three synthetic demo users (demo only) |
| `WEB_ORIGIN` | `http://localhost:3000` | The only origin CORS allows |
| `API_URL` | `http://localhost:4000` | Where the dashboard's `/api` proxy forwards requests |
| `PROVIDER_BASE_URL` | `http://localhost:4000/mock-provider` | Where the provider client sends requests |
| `PROVIDER_TIMEOUT_MS` | `3000` | Per-attempt timeout (AbortController), up to 3 attempts. **Tip:** set `1000` for quicker demos; a forced provider timeout then takes about 3.3 s instead of 9.6 s |
| `MOCK_PROVIDER_ENABLED` | `true` | Mounts the simulated provider; **must be `false` in production** (the API refuses to start otherwise) |
| `MOCK_PROVIDER_DELAY_MS` / `_TIMEOUT_RATE` / `_ERROR_RATE` | `0` | Simulated latency, hang probability and 503 probability |
| `MOCK_PROVIDER_WEBHOOK_URL` | `http://localhost:4000/api/webhooks/payment-provider` | Where the simulated provider sends its signed webhooks |
| `LOGIN_RATE_LIMIT_PER_MIN` | `10` | Login attempts per minute per IP |
| `LOG_LEVEL` | `info` | pino log level (secrets are redacted) |

## API reference

Base path `/api`, JSON everywhere except the webhook route (raw body). Errors always use one shape: `{ "error": { "code", "message", "details?" } }`. Auth is `Authorization: Bearer <jwt>` or the httpOnly `session` cookie (JWT `{ sub, role, merchantId }`, 1 hour).

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | public | `{ ok: true, db: true }` |
| `POST /api/auth/login` | public, rate-limited | `{ email, password }` → `{ token, user: { id, email, role, merchantId, merchantName } }` + `session` cookie (httpOnly, SameSite=Lax). A bad email or password gives the same 401 "Invalid email or password" |
| `POST /api/auth/logout` | any | Clears the cookie (204) |
| `GET /api/auth/me` | signed in | `{ user }` |
| `POST /api/payments` | merchant | Create a payment. Requires `Idempotency-Key` (8–128 printable chars). Body `{ amountPaise, currency?, description?, customerEmail? }`. 201 new · 200 + `Idempotent-Replayed: true` for the same key and body · 409 `IDEMPOTENCY_KEY_REUSED` for the same key with a different body · 400 missing key · 422 invalid body · 403 for admins |
| `GET /api/payments` | merchant / admin | `?page=1&pageSize=10&status=SUCCESS&q=<reference or provider id>&merchantId=<admin only>` → `{ items, page, pageSize, total, totalPages }`, newest first |
| `GET /api/payments/summary` | merchant / admin | `{ totalCount, totalAmountPaise, byStatus: { PENDING, SUCCESS, FAILED } }` (each `{ count, amountPaise }`); admins may pass `merchantId` |
| `GET /api/payments/:id` | merchant / admin | `{ payment, auditTimeline, webhookEvents }`. Each event has `eventId, status, outcome, duplicateDeliveries, occurredAt, receivedAt`, never the payload. Another merchant's payment returns 404 |
| `POST /api/webhooks/payment-provider` | HMAC only (no JWT) | `{ eventId, paymentReference, status, providerPaymentId?, occurredAt }` with `X-Provider-Signature: <hex HMAC-SHA256(raw body)>`; see [responses](#webhook-responses-and-stored-outcomes) |
| `POST /api/admin/reconcile` | admin | Body `{ olderThanMinutes?=0, limit?=200 }` → `{ runId, startedAt, finishedAt, checked, resolved[], mismatches[], unresolved[] }` |
| `GET /api/admin/reconciliation-runs` | admin | `?limit=20` → recent runs with their full reports, newest first |
| `GET /api/admin/merchants` | admin | `{ items: [{ id, name }] }` for the dashboard merchant selector |

Merchant users are always scoped to the merchant in their JWT. A `merchantId` in their query or body is ignored, and `/api/admin/*` answers 403.

**Mock provider:** a simulated external service at `/mock-provider`, not under `/api`. It is mounted only when `MOCK_PROVIDER_ENABLED=true`, and the API refuses to start in production with it enabled.

| Method & path | Purpose |
| --- | --- |
| `POST /mock-provider/payments` | `{ reference, amountPaise }` → provider record; idempotent by reference |
| `GET /mock-provider/payments/:reference` | Provider-side status (what reconciliation reads); 404 if unknown |
| `POST /mock-provider/payments/:reference/settle` | **Demo helper.** `{ status, sendWebhook?=true, webhookDelayMs?=0, duplicates?=1, concurrent?=false, eventId? }` sets the provider status and sends the signed webhook (the same event `duplicates` times). With a delay it answers 202 and delivers later |
| `GET` / `POST /mock-provider/control` | **Demo only.** Reads or changes `{ delayMs, timeoutRate, errorRate }` on the running server; `npm run simulate` uses it to force a provider timeout |

`MOCK_PROVIDER_DELAY_MS`, `_TIMEOUT_RATE` and `_ERROR_RATE` make the register and read endpoints slow, hang or return 503; tests inject these deterministically. A simulated timeout on `POST /payments` **registers the payment and then never answers** (a lost response). This is exactly why the client treats a timeout as "unknown".

Ready-made requests:
- [`docs/api.http`](docs/api.http): VS Code REST Client, every endpoint in demo order.
- [`docs/postman_collection.json`](docs/postman_collection.json): 35 requests with assertions. Webhooks are signed in a pre-request script. Put `demoPassword` and `webhookSecret` in a Postman environment, not in the file.

### Sample curl requests

Bash (Git Bash on Windows), run from the repo root with the API running. `node -p` is used only to pull fields out of JSON responses.

```bash
API=http://localhost:4000
DEMO_PASSWORD='<your SEED_DEMO_PASSWORD>'

# 1. Log in (Merchant A) and keep the token
TOKEN=$(curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"merchant.a@experia.test\",\"password\":\"$DEMO_PASSWORD\"}" \
  | node -p "JSON.parse(require('fs').readFileSync(0)).token")

# 2. Create a payment (₹499.00 = 49900 paise). Re-send with the same key to see the replay.
KEY=$(node -p 'crypto.randomUUID()')
curl -s -i -X POST "$API/api/payments" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  -d '{"amountPaise":49900,"description":"Demo order","customerEmail":"buyer@example.test"}'
REF='PAY_...'   # copy "reference" from the response

# 3. List payments: page, page size, status filter, search
curl -s "$API/api/payments?page=1&pageSize=10&status=SUCCESS&q=PAY_" -H "Authorization: Bearer $TOKEN"
```

**Signed webhook.** The signature is the hex HMAC-SHA256 of the exact raw body, keyed with `PROVIDER_WEBHOOK_SECRET`. Sign the same bytes you send (`--data-raw "$BODY"`).

```bash
BODY="{\"eventId\":\"evt_demo_$(date +%s)\",\"paymentReference\":\"$REF\",\"status\":\"SUCCESS\",\"providerPaymentId\":\"prov_demo_1\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

# Option 1: Node (reads PROVIDER_WEBHOOK_SECRET from .env via dotenv)
SIG=$(node -e "require('dotenv').config({quiet:true});process.stdout.write(require('crypto').createHmac('sha256',process.env.PROVIDER_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")

# Option 2: openssl (export the secret from your .env first)
export PROVIDER_WEBHOOK_SECRET='<value from .env>'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PROVIDER_WEBHOOK_SECRET" | sed 's/^.*= //')

curl -s -X POST "$API/api/webhooks/payment-provider" \
  -H 'Content-Type: application/json' -H "X-Provider-Signature: $SIG" --data-raw "$BODY"
# -> {"received":true,"applied":true,"status":"SUCCESS"}; run it again -> {"received":true,"duplicate":true}

# Tampered body, same signature -> 401 INVALID_SIGNATURE (nothing stored)
curl -s -X POST "$API/api/webhooks/payment-provider" \
  -H 'Content-Type: application/json' -H "X-Provider-Signature: $SIG" --data-raw "${BODY/SUCCESS/FAILED}"
```

**Reconciliation (admin):**

```bash
ADMIN=$(curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@experia.test\",\"password\":\"$DEMO_PASSWORD\"}" \
  | node -p "JSON.parse(require('fs').readFileSync(0)).token")
curl -s -X POST "$API/api/admin/reconcile" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"olderThanMinutes":0}'
```

### Webhook responses and stored outcomes

Checks run in this order: content type → signature (on the raw bytes) → JSON/schema → guards.

| Situation | HTTP | Body | `webhook_events` row |
| --- | --- | --- | --- |
| Body is not `application/json` | 415 | `UNSUPPORTED_MEDIA_TYPE` | none |
| Missing / invalid signature | 401 | `INVALID_SIGNATURE` | none (only "invalid signature" + event id is logged) |
| Signed, but not JSON or fails the schema | 422 | `VALIDATION_ERROR` | none |
| Event id already seen | 200 | `{ received: true, duplicate: true }` | no new row; `duplicate_deliveries` on the original row goes up by 1 |
| Unknown payment reference | 404 | `UNKNOWN_PAYMENT` | `unknown_payment` |
| Valid transition | 200 | `{ received: true, applied: true, status }` | `applied` |
| Same / older status (late, out of order, re-sent) | 200 | `{ received: true, applied: false, reason: "STALE_EVENT" }` | `stale` |
| Contradicts a final status (SUCCESS ↔ FAILED) | 409 | `INVALID_STATUS_TRANSITION` | `invalid_transition`, payment flagged `needs_reconciliation` |

## How duplicates and concurrency are prevented (the three guards)

Each webhook is processed in **one database transaction** ([`api/src/webhooks/processor.ts`](api/src/webhooks/processor.ts)). Every guard is enforced by PostgreSQL, not by application `if`s:

1. **`UNIQUE (provider_event_id)` on `webhook_events`.** `INSERT ... ON CONFLICT DO NOTHING RETURNING id`.
   - A repeated event gets no row back and is answered `{ received: true, duplicate: true }` with no other effect.
   - Concurrent copies block on the unique index until the first transaction commits, then see the conflict.
   - **Repeat counter (visibility only):** on a conflict, the same transaction runs `UPDATE webhook_events SET duplicate_deliveries = duplicate_deliveries + 1 WHERE provider_event_id = $1` and returns. A duplicate never reaches the payment lock or `applyTransition`, so it cannot move money.
   - Only signature-valid deliveries are counted; a bad signature is rejected before the database is touched. The dashboard uses the counter for its "5 deliveries received · 1 applied · 4 duplicates" line.
2. **`SELECT ... FOR UPDATE` on the payment row.** Different events for the same payment queue up, and each sees the status left by the one before it. Two different SUCCESS events therefore cannot both apply.
3. **`UNIQUE (payment_id, entry_type)` on `ledger_entries`.** A payment can be captured at most once, even if a bug ever let two SUCCESS transitions through. Reconciliation uses the same guard.

Tests 5–7 in [`api/tests/webhooks.test.ts`](api/tests/webhooks.test.ts) prove it: the same SUCCESS event ×5 sequentially, ×5 concurrently (`Promise.all`), and two *different* SUCCESS events concurrently. Each case leaves exactly **1** ledger entry and **1** `PENDING → SUCCESS` audit row, checked directly in the database. Tests 5 and 6 also check `duplicate_deliveries = 4` on the single stored event, and that a bad-signature copy is not counted. `npm run simulate` repeats the demonstration against the running server.

**Payment creation** has its own guard: `UNIQUE (merchant_id, idempotency_key)`.
- The handler runs `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, so exactly one concurrent request inserts the row.
- The others read it back and either replay it (same SHA-256 of the canonical, validated body) or get 409.
- The `null → PENDING` audit row is written in the same transaction as the payment.

Test 13 sends the same key 5 times concurrently and gets exactly one row.

## State machine

`applyTransition` ([`api/src/domain/applyTransition.ts`](api/src/domain/applyTransition.ts)) is the only code that changes `payments.status`. The table lives in [`api/src/domain/stateMachine.ts`](api/src/domain/stateMachine.ts), and test 18 checks every combination.

| Current \ Event | PENDING | SUCCESS | FAILED |
| --- | --- | --- | --- |
| **PENDING** | stale (no-op) | **applied** + ledger CAPTURE | **applied** |
| **SUCCESS** | stale (late / out of order) | stale (re-sent, any event id) | invalid → 409, flagged `needs_reconciliation` |
| **FAILED** | stale (late / out of order) | invalid → 409, flagged `needs_reconciliation` | stale |

An applied transition updates the status, clears `needs_reconciliation` and writes one audit row; an invalid one never overwrites the final status. `payment_audit_log` and `ledger_entries` are append-only: a trigger raises on UPDATE or DELETE (test 17).

## Timeouts, retries and reconciliation

- **Provider client** ([`api/src/provider/providerClient.ts`](api/src/provider/providerClient.ts)):
  - Every attempt has an `AbortController` timeout (`PROVIDER_TIMEOUT_MS`).
  - Only idempotent calls are retried: status reads, and registration, which is idempotent by reference.
  - Up to **3 attempts**, with exponential backoff and **full jitter** (`random() × min(2000, 200 × 2^(n-1))` ms). Retries happen on timeouts, network errors and 408/429/5xx; other 4xx answers are final.
  - Results are typed: `ok` / `timeout` / `error`.
- **A timeout on create is "unknown", never "failed"** (test 15). The payment is committed before the provider is called. It still returns 201, stays `PENDING`, and gets `needs_reconciliation = true` plus `last_provider_error`.
- **Out-of-order and delayed delivery:** a late PENDING after SUCCESS is `stale` (test 9), and FAILED after SUCCESS is a 409 (test 8). `npm run simulate` also delivers a webhook 3 s after settlement.
- **Reconciliation** ([`api/src/reconciliation/service.ts`](api/src/reconciliation/service.ts)) runs from `npm run reconcile` or `POST /api/admin/reconcile`. It checks `PENDING` and flagged payments against `GET /mock-provider/payments/:reference`:

| Ours | Provider says | Result |
| --- | --- | --- |
| PENDING | SUCCESS / FAILED | **resolved** through `applyTransition` (source `reconciliation`, `source_ref` = run id), CAPTURE ledger entry on SUCCESS (same unique guard) |
| PENDING | PENDING / not found / timeout / error | **unresolved**, untouched |
| SUCCESS / FAILED (flagged) | the same status | **resolved**: our status is confirmed and the flag is cleared |
| SUCCESS / FAILED | the other final status | **mismatch**: reported, **never overwritten**, stays flagged |
| any | different amount | **mismatch** (`reason: amount`), flagged |

Each candidate is re-read `FOR UPDATE` before acting, so a webhook arriving at the same moment is serialised with it. Every run is stored in `reconciliation_runs` with its full report. Re-running changes nothing: test 16 compares a database snapshot before and after a second run.

## Running tests

```bash
npm test               # the API suite against TEST_DATABASE_URL (migrated automatically)
npm run test:report    # verbose output saved to docs/test-results.txt
npm run simulate       # with the API running: end-to-end scenarios against the live server
```

Tests use a separate, real PostgreSQL database. Tables are truncated between tests, provider behaviour is injected (no randomness), and concurrency cases use `Promise.all` against the real database.

**Latest result: 13 files, 131 tests, all passing** ([`docs/test-results.txt`](docs/test-results.txt)).

| File | Tests | Covers |
| --- | --- | --- |
| `webhooks.test.ts` | 18 | 1–4 signature (valid, invalid, missing, body altered), **5–7 duplicates and concurrency**, 8 invalid transition, 9 late PENDING, unknown payment, what is stored |
| `payments.test.ts` | 21 | creation, **11–13 idempotency** (replay, key reuse, ×5 concurrent), **14 validation**, provider registration |
| `reliability.test.ts` | 4 | **15** provider timeout on create → PENDING + `needs_reconciliation`, never FAILED |
| `reconciliation.test.ts` | 6 | **16** resolve / unresolved on timeout / mismatch not overwritten / second run changes nothing |
| `appendOnly.test.ts` | 6 | **17** UPDATE/DELETE on `ledger_entries` and `payment_audit_log` raise |
| `stateMachine.test.ts` | 11 | **18** the full transition table |
| `isolation.test.ts` | 11 | **10** merchant isolation (404 on another merchant's payment, own-only lists, 403 on admin routes) |
| `auth.test.ts` | 12 | login, generic errors, rate limit, cookie flags, `me`, logout |
| `paymentQueries.test.ts` | 8 | pagination, filters, search, summary, details (no payload, `duplicateDeliveries`) |
| `providerClient.test.ts` | 8 | retries only on retryable failures, timeouts, full-jitter backoff |
| `mockProvider.test.ts` | 11 | provider store, deterministic failures, signed settle webhooks, disabled mode (404) |
| `platform.test.ts` | 12 | health, error shape, config validation (placeholder secrets refused), log redaction, test-database guard |
| `admin.test.ts` | 3 | merchants endpoint and its access rules |

## Screenshots

Taken from the running app (`docs/screenshots/`):

| | |
| --- | --- |
| ![Login](docs/screenshots/01-login.png) Login with demo accounts | ![Dashboard](docs/screenshots/02-dashboard.png) Summary cards + transactions (Merchant A) |
| ![Filters](docs/screenshots/03-filters.png) Search, status filter, pagination | ![Details](docs/screenshots/04-details.png) Details: audit timeline + "5 deliveries · 1 applied · 4 duplicates" |
| ![Empty or error state](docs/screenshots/05-empty-error.png) Empty / error state | ![Mobile](<docs/screenshots/06-mobile(1).png>) ![Mobile, continued](<docs/screenshots/06-mobile(2).png>) Phone width (375 px) |
| ![Tests](docs/screenshots/07-tests.png) `npm test`: all passing | ![Simulate](docs/screenshots/08-simulate.png) `npm run simulate`: duplicates ignored |
| ![Reconcile](docs/screenshots/09-reconcile.png) `npm run reconcile` | |

## Dashboard (web/)

Next.js 15 App Router + Tailwind CSS 4 + TanStack Query, at http://localhost:3000.

- **`/login`:** email/password with inline errors, plus three "Use demo account" buttons.
  - In development the buttons also fill the synthetic demo password, which `next.config.ts` inlines only when `NODE_ENV` is not `production`.
  - A production build never contains it; there the buttons fill the email only.
- **`/dashboard`:**
  - Five summary cards (total payments, total volume, success, pending, failed), debounced search by reference or provider id, a status filter, and server-side pagination with page size.
  - All filters live in the URL, so refresh, back and shared links keep them.
  - Merchants get a "Create test payment" dialog. The amount in ₹ is converted to integer paise without floats, and the `Idempotency-Key` comes from `crypto.randomUUID()`, reused when the same form is resubmitted after a network error.
  - Admins get a merchant selector in the top bar ("All merchants" by default) that scopes the cards and the table, and no create button.
- **`/payments/[id]`:**
  - Amount, status, and references with copy buttons.
  - An amber **Needs reconciliation** banner that explains why: a rejected conflicting webhook, the last provider error, or a reconciliation mismatch.
  - The audit timeline (from → to, source, time, run or event id).
  - The webhook events table, headed by a one-line summary such as "5 deliveries received · 1 applied · 4 duplicates".
- **States everywhere:** skeletons while loading, empty states ("No payments yet" + create), errors with Retry, and "Payment not found" for a missing id *or another merchant's payment*.
- **Auth:**
  - Uses the API's httpOnly `session` cookie, made same-origin by a Next.js rewrite (`/api/*` → `API_URL`). No token is stored in JavaScript.
  - `middleware.ts` redirects visitors without a session to `/login?next=...` (same-site paths only), and any 401 does the same.
- **Design:**
  - Neutral surfaces, one indigo accent, light and dark mode (follows the system; the toggle is remembered, with no flash on load).
  - Inter + JetBrains Mono via `next/font`, tabular numbers, `Intl.NumberFormat('en-IN')` for rupees.
  - Status badges always pair a text label with the dot, so they read in greyscale.
  - Visible focus rings, a native `<dialog>`, a table that becomes stacked cards below 640 px, and short fade-ins that are disabled under `prefers-reduced-motion`.
- **Private by default:** `robots: { index: false, follow: false }`, `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`.

## Key decisions

- **The database enforces the guarantees.** Unique constraints, row locks, transactions and append-only triggers do the work, not application checks alone.
- **An event is stored and processed in one transaction.** It is saved with its outcome (`applied`, `stale`, `invalid_transition`, `unknown_payment`) or not at all.
- **Conflicts are flagged, not auto-resolved.** SUCCESS ↔ FAILED gets a 409, the payment is flagged, and reconciliation reports it. A person decides.
- **A timeout means "unknown".** The payment is committed before the provider call. Only a signed webhook or reconciliation settles it.
- **404, not 403, for another merchant's payment**, so ids don't reveal whether a payment exists.
- **Money is integer paise** (`BIGINT` / safe integers), shown as rupees only in the UI. One payment is capped at ₹1 crore.
- **The dashboard calls the API through a same-origin proxy.** The httpOnly cookie never reaches JavaScript, and the API keeps a strict CORS allow-list.
- **Plain SQL on payment paths**, so locking and conflict handling are visible in the code.
- **The mock provider has its own table**, so reconciliation compares two separate records.

## Limitations & what I'd do next

- **No webhook replay window.** A validly signed event is accepted whatever its age. Next step: a signed timestamp header, rejecting events older than about 5 minutes. Replays of a *stored* event are still harmless (guard #1).
- **No secret rotation** for `PROVIDER_WEBHOOK_SECRET`. A real provider would allow two active secrets during rotation.
- **Webhooks are processed synchronously** in the request. The optional store-then-process queue (`webhook_jobs` drained with `FOR UPDATE SKIP LOCKED`) was skipped to protect the deadline; it would decouple acknowledgement from processing.
- **Reconciliation runs on demand** (CLI or admin endpoint), not on a schedule. Next step: a cron job running `reconcile({ olderThanMinutes: 5 })`.
- **Payment creation waits for the provider.** With the provider down, `POST /api/payments` can take up to about 3 × `PROVIDER_TIMEOUT_MS` plus backoff (about 9.6 s at the default) before answering 201. A background registration job would make it instant.
- **Payments the provider never received are not re-registered.** Reconciliation reports them as `provider_not_found` (unresolved) for a human.
- **Events for unknown payments are stored** (outcome `unknown_payment`, 404). If the provider retries the *same* event id, it is treated as a duplicate; reconciliation is what catches such payments.
- **The mock provider** is unauthenticated by design (it is the simulated outside world) and lives in the same database (its own table). Its `/control` and `/settle` endpoints exist only for the demo, and the API refuses to start with it enabled in production.
- **Stateless JWT sessions:** a 1-hour expiry, no refresh tokens and no server-side revocation (logout clears the cookie only).
- **CSRF:** cookie auth relies on `SameSite=Lax`, a CORS allow-list and JSON-only bodies; there is no separate CSRF token.
- **The dashboard sends no Content-Security-Policy.** The API has helmet's CSP, but a CSP for Next.js needs per-request nonces (including for the theme script).
- **The dashboard's middleware only checks that a session cookie exists.** The API verifies the JWT on every request; verifying it in middleware too would mean sharing `JWT_SECRET` with the web app.
- **Single instance:** login rate limiting uses the in-memory store.
- **TRUNCATE is not blocked** on the append-only tables. UPDATE and DELETE raise via triggers, but the seed script and tests need TRUNCATE; in production the application role would not be granted it.
- **Idempotency keys never expire.** A key stays bound to its payment forever; real providers usually expire them after about 24 hours.
- **Single-payment cap of ₹1 crore** (`amountPaise ≤ 1000000000`), an assessment choice that also keeps every sum far inside JavaScript's safe-integer range.
- **Search** is a case-insensitive substring match (`ILIKE`) without a trigram index, and pagination is offset-based. Both are fine for demo volumes; large data would need `pg_trgm` and keyset pagination.
- **`npm audit`:** 9 moderate advisories, all in development tooling (`glob`/`minimatch` via the `node-pg-migrate` CLI and `typescript-eslint`). None is reachable from the running API or dashboard, and no non-breaking fix exists yet. Next.js 15 pins `postcss@8.4.31` (a high-severity advisory); a root `overrides` entry raises it to the patched `8.5.33`.
- **Dashboard lint uses ESLint's legacy config mode** (`ESLINT_USE_FLAT_CONFIG=false` + `.eslintrc.json`). `eslint-config-next` 15 ships only that format, and the flat-config shim is not on the approved dependency list. ESLint 9 still supports it, with a deprecation warning.

## Assessment checklist

| Requirement | Where | Proof |
| --- | --- | --- |
| Webhook HMAC-SHA256 verification over the raw body, constant-time compare | `api/src/lib/hmac.ts`, `api/src/webhooks/routes.ts`, `api/src/app.ts` (raw before json) | tests 1–4; simulate scenario 5 |
| Invalid / missing signature stores nothing, logs no secrets | `api/src/webhooks/routes.ts`, `api/src/lib/logger.ts` | tests 2–3; `platform.test.ts` (redaction) |
| Duplicate webhooks have no second effect (×5 sequential and concurrent) | `api/src/webhooks/processor.ts` (guard 1), `migrations/` (unique constraints) | tests 5–6; simulate scenario 2 |
| Concurrency-safe processing | row lock (guard 2), unique ledger (guard 3) | tests 6–7, 13 |
| Payment state machine, terminal states, invalid transitions | `api/src/domain/stateMachine.ts`, `applyTransition.ts` | tests 8, 9, 18; simulate scenarios 3–4 |
| Out-of-order and delayed webhooks | `applyTransition` (stale handling) | test 9; simulate scenarios 3 and 6 |
| Payment initiation with `Idempotency-Key` | `api/src/payments/service.ts`, `routes.ts` | tests 11–14; simulate scenario 1 |
| Input validation (amount, currency, email) | `api/src/payments/schemas.ts`, `api/src/webhooks/schema.ts` | test 14; `payments.test.ts` |
| Provider timeouts and retries (never "failed" on timeout) | `api/src/provider/providerClient.ts` | test 15; `providerClient.test.ts`; simulate scenario 7 |
| Reconciliation (resolve, unresolved, mismatch, idempotent rerun) | `api/src/reconciliation/service.ts`, `api/scripts/reconcile.ts`, `POST /api/admin/reconcile` | test 16; simulate scenario 7 |
| Single financial effect per payment (ledger) | `ledger_entries UNIQUE (payment_id, entry_type)` | tests 1, 5–7, 16 |
| Audit trail, append-only | `payment_audit_log` + triggers in `migrations/` | test 17 |
| Merchant isolation and roles | `api/src/auth/` (`merchantScope.ts`, `middleware.ts`) | test 10; `isolation.test.ts`, `admin.test.ts` |
| Secure auth (bcrypt, JWT ≥ 32-char secret, httpOnly cookie, rate-limited login, generic errors) | `api/src/auth/`, `api/src/config.ts` | `auth.test.ts`, `platform.test.ts` |
| Security headers, CORS allow-list, body limits, no stack traces | `api/src/app.ts`, `api/src/middleware/errorHandler.ts` | `platform.test.ts` (headers, CORS, error shape); body limits and the stack-free handler by code review |
| Secrets only in `.env`; `.env.example` placeholders | `.gitignore`, `.env.example`, `api/src/config.ts` (placeholder refusal) | `platform.test.ts`; history checked |
| Dashboard: summary, list, search, status filter, server-side pagination | `web/components/dashboard/` | manual + screenshots 02–03 |
| Dashboard: create payment with idempotency key | `web/components/dashboard/CreatePaymentDialog.tsx` | manual |
| Dashboard: payment details, audit timeline, webhook events | `web/components/payment/` | screenshot 04 |
| Loading / empty / error / not-found states, responsive, dark mode, accessible badges | `web/components/ui.tsx`, `web/app/` | screenshots 05–06 |
| Mock provider with simulated delay / timeout / error | `api/src/provider/mockProviderRouter.ts` | `mockProvider.test.ts` |
| Demo script for duplicates, concurrency, out-of-order, bad signature, timeout | `api/scripts/simulate.ts` | `npm run simulate` (7/7 PASS) |
| Seed data: two fictional merchants, about 80 payments, reconciliation cases | `api/scripts/seed.ts` | `npm run seed` |
| Docs: README, sample requests, test results | `README.md`, `docs/api.http`, `docs/test-results.txt` | this file |
| Bonus: Docker Postgres, Postman collection, append-only triggers | `docker-compose.yml`, `docs/postman_collection.json`, `migrations/` | test 17 |
| Bonus: store-then-process webhook queue | not done | see Limitations |
