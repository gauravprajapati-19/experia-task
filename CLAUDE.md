# CLAUDE.md — Experia360 Technical Assessment

> Secure Payment Webhook Processor & Merchant Transaction Dashboard
> **Deadline: Sunday 15 Nov 2026, 6:00 PM IST.** Correctness and security come before feature count.
> If something cannot be finished, it must be written down in the README under "Limitations", never silently skipped.

This file is the single source of truth for this repo. Read it fully before writing any code, and re-read the relevant section before each phase.

---

## 1. Ground rules

1. **Mock everything.** Use only simulated provider responses and synthetic merchant/payment data. No real banking or payment credentials, no real customer data, no real money. No external payment SDKs (no Razorpay/Stripe packages).
2. **Secrets never in git or logs.** All secrets come from `.env` (gitignored). Commit only `.env.example` with placeholder values. Logs must redact `authorization`, `cookie`, `x-provider-signature`, passwords, tokens and secrets.
3. **Money is integer paise** (`BIGINT` in PostgreSQL, `number` validated as a safe positive integer in TypeScript). Never floats. Format to rupees only in the UI.
4. **Correctness first:** every guarantee in Section 6 must be enforced by the **database** (unique constraints, row locks, transactions), not only by application `if` checks.
5. **TypeScript strict mode** everywhere. No `any` unless commented why.
6. **Small, readable code.** Reviewers will read it. Prefer clear names and short functions over clever abstractions. Add brief comments where a guarantee is enforced (e.g. `// duplicate guard #1: unique provider_event_id`).
7. **Commit after each phase** with a clear message (e.g. `feat(webhooks): signed webhook processing with idempotent state machine`). Never commit `.env`, `node_modules`, build output, or `SETUP_GUIDE.md`.
8. **Ask before** adding a dependency that is not listed in Section 3, or before changing the API contract in Section 5.
9. **Run the tests at the end of every phase** and show the result. Do not move on with failing tests.
10. When something is a simplification for the assessment (e.g. no replay window), write it in the README "Limitations" section as you go.

---

## 2. Repository layout (npm workspaces monorepo)

```
experia-task/
├─ CLAUDE.md
├─ README.md
├─ docker-compose.yml          # postgres:16 (dev db + test db)
├─ .env.example                # placeholders only
├─ .gitignore
├─ package.json                # workspaces: ["api", "web"], root scripts
├─ api/                        # Express + TypeScript backend
│  ├─ src/
│  │  ├─ app.ts                # builds the Express app (no listen) — used by tests
│  │  ├─ server.ts             # listen()
│  │  ├─ config.ts             # zod-validated env
│  │  ├─ db/                   # pg Pool, tx helper, query helpers
│  │  ├─ auth/                 # login, JWT, requireAuth, requireRole, merchant scope
│  │  ├─ payments/             # initiation, idempotency, list, summary, details
│  │  ├─ webhooks/             # raw-body route, signature verify, processor
│  │  ├─ domain/               # stateMachine.ts, applyTransition.ts, money.ts
│  │  ├─ provider/             # mockProvider (external simulator) + providerClient (timeouts/retries)
│  │  ├─ reconciliation/       # reconcile service + CLI entry
│  │  ├─ middleware/           # error handler, request id, logging
│  │  └─ lib/                  # hmac, ids, logger
│  ├─ migrations/              # node-pg-migrate SQL migrations
│  ├─ scripts/
│  │  ├─ seed.ts
│  │  ├─ simulate.ts           # demo: duplicates x5, concurrency, out-of-order, delays, bad signature, timeout
│  │  └─ reconcile.ts          # `npm run reconcile`
│  └─ tests/                   # vitest + supertest
├─ web/                        # Next.js (App Router) + TypeScript + Tailwind dashboard
└─ docs/
   ├─ api.http                 # sample requests (REST Client format) + curl in README
   ├─ postman_collection.json  # bonus
   ├─ test-results.txt         # saved verbose test output
   └─ screenshots/
```

---

## 3. Tech stack (use exactly these unless asked)

| Area | Choice |
| --- | --- |
| Runtime | Node.js 20 LTS, npm workspaces |
| API | Express 4, TypeScript (strict), `tsx` for dev |
| DB | PostgreSQL 16, `pg` (node-postgres) with **plain SQL** for payment paths |
| Migrations | `node-pg-migrate` (SQL migrations) |
| Validation | `zod` |
| Auth | `jsonwebtoken`, `bcryptjs` (pure JS, works on Windows without build tools) |
| Security middleware | `helmet`, `cors`, `express-rate-limit` (login route) |
| IDs | `ulid` for references/event ids, `crypto.randomUUID()` for primary keys |
| Logging | `pino` + `pino-http` with `redact` |
| Tests | `vitest` + `supertest`, real PostgreSQL test database |
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind CSS, TanStack Query, `lucide-react` icons |
| Bonus | `docker-compose.yml` for Postgres; `docs/postman_collection.json`; append-only DB triggers |
| Cookies | `cookie-parser` 1.4.7 (reads the `session` cookie) |
| Env loading | `dotenv` 17.4.2 (root `.env` for API, scripts, migrations and tests) |
| Scripts | `concurrently` 10.0.7 (`npm run dev`), `cross-env` 10.1.0 (`NODE_ENV` in npm scripts on Windows) |
| Lint | `eslint` 9.39.5 + `typescript-eslint` 8.72.2 (type-checked rules); `eslint-config-next` for web |
| Types | `@types/express` 4.17.25, `@types/pg`, `@types/jsonwebtoken`, `@types/cors`, `@types/cookie-parser`, `@types/supertest`, `@types/node` 20 |

**Pinned versions (exact, `.npmrc save-exact`):** express 4.22.3, pg 8.23.1, node-pg-migrate 9.0.0, zod 4.6.7, jsonwebtoken 9.0.3, bcryptjs 3.0.3, helmet 8.3.0, cors 2.8.6, express-rate-limit 8.7.4, ulid 3.0.2, pino 10.4.0, pino-http 11.0.0, typescript 5.9.3, tsx 4.23.15, vitest 4.1.12, supertest 7.3.2. Root `overrides` pins `vite` 7.3.8 (vitest's peer; vite 8's optional devtools peer crashes npm's resolver).
Version notes: TypeScript 5.9 (typescript-eslint supports < 6.1), ESLint 9 (eslint-config-next 15 supports ≤ 9), Vitest 4 (Vitest 5 requires Node ≥ 22.12; Node 20.19+ stays supported).

`DATABASE_URL` and `TEST_DATABASE_URL` must work with **any** PostgreSQL (Docker, local install, or Neon). Do not hard-code Docker hostnames.

---

## 4. Data model (migrations)

All timestamps `timestamptz default now()`.

**merchants** — `id uuid pk`, `name text not null`, `created_at`.

**users** — `id uuid pk`, `email text unique not null`, `password_hash text not null`, `role text check (role in ('admin','merchant'))`, `merchant_id uuid null references merchants`, `created_at`. Check: `role = 'admin' OR merchant_id IS NOT NULL`.

**payments** —
- `id uuid pk`, `merchant_id uuid not null references merchants`
- `reference text unique not null` (internal, e.g. `PAY_<ULID>`)
- `amount_paise bigint not null check (amount_paise > 0)`, `currency text not null default 'INR' check (currency = 'INR')`
- `status text not null check (status in ('PENDING','SUCCESS','FAILED'))`
- `idempotency_key text not null`, `request_hash text not null`
- `provider_payment_id text null`, `needs_reconciliation boolean not null default false`, `last_provider_error text null`
- `description text null`, `customer_email text null` (synthetic)
- `created_at`, `updated_at`
- **`unique (merchant_id, idempotency_key)`**
- indexes: `(merchant_id, created_at desc)`, `(merchant_id, status)`

**webhook_events** —
- `id uuid pk`, **`provider_event_id text unique not null`**
- `payment_reference text not null`, `payment_id uuid null references payments`
- `event_status text not null` (SUCCESS / FAILED / PENDING as received)
- `occurred_at timestamptz not null` (provider time), `received_at`
- `payload jsonb not null` (the parsed body — never headers/signature)
- `outcome text not null check (outcome in ('applied','duplicate','stale','invalid_transition','unknown_payment'))`
- `duplicate_deliveries int not null default 0` (added with approval, own migration): incremented in the Guard 1 transaction when a signature-valid delivery hits the unique conflict; visibility only, returned as `duplicateDeliveries` by `GET /api/payments/:id`

**payment_audit_log** (append-only) — `id bigserial pk`, `payment_id uuid not null`, `from_status text null`, `to_status text not null`, `source text check (source in ('api','webhook','reconciliation'))`, `source_ref text null` (event id / run id), `actor text null`, `note text null`, `created_at`.

**ledger_entries** (append-only, simulated financial effect) — `id bigserial pk`, `payment_id uuid not null references payments`, `merchant_id uuid not null`, `entry_type text not null check (entry_type in ('CAPTURE'))`, `amount_paise bigint not null`, `created_at`, **`unique (payment_id, entry_type)`**.

**mock_provider_payments** (the simulated external provider's own store — kept separate on purpose so reconciliation compares two sources) — `provider_payment_id text pk`, `payment_reference text unique not null`, `amount_paise bigint not null`, `status text not null`, `updated_at`.

**reconciliation_runs** — `id uuid pk`, `started_at`, `finished_at`, `checked int`, `resolved int`, `mismatches int`, `unresolved int`, `report jsonb`.

**Append-only triggers:** a trigger function on `payment_audit_log` and `ledger_entries` that raises an exception on `UPDATE` or `DELETE`. Test it.

**Seed (`npm run seed`):**
- Merchants: "Nova Retail" (Merchant A) and "Orbit Foods" (Merchant B) — clearly fictional.
- Users: `admin@experia.test` (admin), `merchant.a@experia.test`, `merchant.b@experia.test`. Password from `SEED_DEMO_PASSWORD` in `.env` (placeholder in `.env.example`, documented in README as demo-only).
- ~40 synthetic payments per merchant across all statuses over the last 30 days, with matching audit rows, ledger entries for SUCCESS, and matching `mock_provider_payments` rows. Include 2–3 deliberate **mismatches/unresolved** PENDING payments so reconciliation has something to show.
- Seed must be idempotent (safe to run twice) — truncate-and-reseed in dev only, never in test.

---

## 5. API contract

Base path `/api`. JSON everywhere except the webhook route (raw body). Errors use one shape:
`{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/login` | public, rate-limited | `{email, password}` → `{ token, user: {id, email, role, merchantId} }`; also sets an httpOnly `SameSite=Lax` cookie `session` |
| `POST /api/auth/logout` | any | clears cookie |
| `GET /api/auth/me` | any | current user |
| `POST /api/payments` | merchant | create payment (Section 6.2). Header **`Idempotency-Key`** required |
| `GET /api/payments` | merchant / admin | server-side pagination: `?page=1&pageSize=10&status=SUCCESS&q=<reference or provider id>&merchantId=<admin only>` → `{ items, page, pageSize, total, totalPages }` |
| `GET /api/payments/summary` | merchant / admin | `{ totalCount, totalAmountPaise, byStatus: {PENDING:{count,amountPaise}, SUCCESS:{...}, FAILED:{...}} }` |
| `GET /api/payments/:id` | merchant / admin | payment + audit timeline + webhook events (no payload secrets) |
| `POST /api/webhooks/payment-provider` | **HMAC only** (no JWT) | Section 6.3 |
| `POST /api/admin/reconcile` | admin | runs reconciliation, returns report |
| `GET /api/admin/reconciliation-runs` | admin | recent runs |
| `GET /api/admin/merchants` | admin | `{ items: [{ id, name }] }` for the dashboard merchant selector (added with approval) |
| `GET /api/health` | public | `{ ok: true, db: true }` |

**Mock provider (simulated external service, mounted at `/mock-provider`, NOT under `/api`):**
| `POST /mock-provider/payments` | create provider payment for a reference (idempotent by reference) |
| `GET /mock-provider/payments/:reference` | provider status source used by reconciliation |
| `POST /mock-provider/payments/:reference/settle` | demo helper: set provider status and optionally fire a signed webhook (with optional delay/duplicates) |
| `GET`/`POST /mock-provider/control` | demo helper (added in Phase 4): read/change `{ delayMs, timeoutRate, errorRate }` at runtime so `simulate.ts` can force a provider timeout on the running server |

Auth accepts `Authorization: Bearer <jwt>` **or** the `session` cookie. JWT payload: `{ sub, role, merchantId }`, expiry 1h, secret `JWT_SECRET` (min 32 chars, validated at boot).

---

## 6. Behaviour that must be correct (the core of the assessment)

### 6.1 Merchant isolation
- Every query for a merchant user is scoped `WHERE merchant_id = $merchantId` taken **from the JWT**, never from the request body/query.
- Accessing another merchant's payment by id returns **404** (not 403) so existence is not leaked.
- Admin can read all merchants and filter with `merchantId`. Admin cannot create payments (returns 403).
- Merchants cannot call `/api/admin/*` (403).

### 6.2 Payment initiation — `POST /api/payments`
Body (zod): `{ amountPaise: positive safe integer ≤ 10_000_000_00 (₹1 crore cap, documented), currency?: 'INR', description?: string ≤ 140, customerEmail?: email }`. Missing/invalid → **422**.
`Idempotency-Key` header required (8–128 chars) → missing **400**.

Flow:
1. `requestHash = sha256(canonical JSON of validated body)`.
2. In a transaction: `INSERT INTO payments (...) VALUES (... 'PENDING' ...) ON CONFLICT (merchant_id, idempotency_key) DO NOTHING RETURNING *`.
3. If no row returned → `SELECT` the existing payment for that `(merchant_id, idempotency_key)`:
   - same `request_hash` → return **200** with the original payment and header `Idempotent-Replayed: true`
   - different hash → **409** `IDEMPOTENCY_KEY_REUSED`
4. New row → write audit row `null → PENDING` (source `api`), commit, then call the provider client to register the payment with the mock provider (Section 6.5). Return **201**.
5. If the provider call times out or errors: payment **stays PENDING**, set `needs_reconciliation = true` and `last_provider_error`; still return 201 (the payment exists; its outcome is unresolved). Never mark FAILED because of a timeout.
6. Two concurrent requests with the same key must produce exactly **one** row (the unique constraint guarantees it; test it).

### 6.3 Signed webhook — `POST /api/webhooks/payment-provider`
Payload (zod): `{ eventId: string, paymentReference: string, status: 'SUCCESS'|'FAILED'|'PENDING', providerPaymentId?: string, occurredAt: ISO string }`.
Header: `X-Provider-Signature: <hex HMAC-SHA256(rawBody, PROVIDER_WEBHOOK_SECRET)>`.

1. Mount this route with `express.raw({ type: 'application/json', limit: '100kb' })` **before** the global `express.json()`, so the exact raw bytes are verified.
2. Verify with `crypto.timingSafeEqual` (check lengths first). Missing/invalid → **401** `INVALID_SIGNATURE`; **store nothing**, log only "invalid signature" + eventId if parseable (no body, no header value).
3. Parse + validate the JSON after verification → invalid **422**.
4. One DB transaction:
   - **Guard 1 (dedupe):** `INSERT INTO webhook_events (...) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`. Nothing returned → duplicate → commit → **200** `{ received: true, duplicate: true }`. No other effect.
   - Look up the payment by reference **`FOR UPDATE`** (**Guard 2: row lock** serialises concurrent events for one payment). Unknown reference → set outcome `unknown_payment`, commit, **404**.
   - Call `applyTransition(tx, payment, event.status, { source: 'webhook', sourceRef: eventId })` (Section 6.4).
   - On `SUCCESS` applied → `INSERT INTO ledger_entries (payment_id, 'CAPTURE', ...) ON CONFLICT (payment_id, entry_type) DO NOTHING` (**Guard 3: unique ledger**).
   - Update the webhook event's `outcome` and `payment_id`. Commit.
5. Responses: applied → **200** `{received:true, applied:true, status}`; stale → **200** `{received:true, applied:false, reason:'STALE_EVENT'}`; invalid transition → **409** `INVALID_STATUS_TRANSITION` (event is still stored with outcome `invalid_transition` and the payment gets `needs_reconciliation = true`).

**Mandatory demonstration:** the same SUCCESS event sent **5 times** (sequentially AND concurrently) → payment status changes exactly once, exactly **1** ledger entry, exactly **1** `PENDING → SUCCESS` audit row, 4 responses with `duplicate: true` (or stale for concurrent ones that lose the race after dedupe — whichever, the financial effect must be single). This must be an automated test AND part of `scripts/simulate.ts`.

### 6.4 State machine (`domain/stateMachine.ts` + `applyTransition.ts`)
- Allowed: `PENDING → SUCCESS`, `PENDING → FAILED`. `SUCCESS` and `FAILED` are **terminal**.
- `PENDING` event while already `PENDING` → no-op, outcome `stale`.
- `PENDING` event after `SUCCESS`/`FAILED` (late / out-of-order) → outcome `stale`, no change, 200.
- `SUCCESS` after `FAILED` or `FAILED` after `SUCCESS` → `invalid_transition`, 409, no change, flag for reconciliation.
- Same terminal status again with a **different** event id (e.g. provider re-sends SUCCESS with a new id) → `stale`, no change, no new ledger entry.
- `applyTransition` is the **only** function that changes `payments.status`. It always: checks the transition, updates `status` + `updated_at`, clears `needs_reconciliation` when resolved, writes one audit row. Unit-test the state machine table.

### 6.5 Reliability: delays, out-of-order, timeouts, retries
- **Mock provider** (`provider/mockProvider.ts` + router) is configurable by env: `MOCK_PROVIDER_DELAY_MS`, `MOCK_PROVIDER_TIMEOUT_RATE` (0–1), `MOCK_PROVIDER_ERROR_RATE` (0–1). Tests set these deterministically (inject config, no randomness in tests).
- **Provider client** (`provider/providerClient.ts`): `AbortController` timeout (`PROVIDER_TIMEOUT_MS`, default 3000); retries **only** for safe/idempotent calls (status reads; create is idempotent by reference) with exponential backoff + full jitter, max 3 attempts. A timeout result is a typed `{ kind: 'timeout' }` — callers must treat it as **unknown**, never as failure.
- **Out-of-order / delayed delivery** is simulated in `scripts/simulate.ts` and covered by tests (late PENDING after SUCCESS; FAILED arriving after SUCCESS).
- **Concurrency:** covered by the three guards above; tests fire parallel requests with `Promise.all`.
- **Bonus (only if time allows after everything else passes):** store-then-process queue using a `webhook_jobs` table drained with `SELECT ... FOR UPDATE SKIP LOCKED`. If not done, mention it in Limitations.

### 6.6 Reconciliation
- Service `reconcile({ olderThanMinutes = 0, limit = 200 })`, exposed as `npm run reconcile` (CLI prints a table) and `POST /api/admin/reconcile`.
- Checks: payments that are `PENDING` (or `needs_reconciliation = true`) against `GET /mock-provider/payments/:reference` via the provider client.
- Rules:
  - Internal `PENDING` + provider definitive `SUCCESS`/`FAILED` → **resolve** through `applyTransition` (source `reconciliation`, sourceRef = run id), ledger entry if SUCCESS (same unique guard).
  - Provider timeout/error/`PENDING`/not found → **unresolved**, leave untouched.
  - Internal terminal status ≠ provider terminal status → **mismatch**: report it, **do not overwrite**, keep `needs_reconciliation = true`.
- Persist a `reconciliation_runs` row with the full report `{ checked, resolved[], mismatches[], unresolved[] }`.
- Re-running reconciliation must be idempotent (no double ledger entries).

### 6.7 Security checklist
- Helmet, CORS restricted to `WEB_ORIGIN`, JSON body limit, login rate limit (e.g. 10/min/IP), generic login error ("Invalid email or password").
- Passwords bcrypt (cost 10+). JWT secret ≥ 32 chars, validated by zod at startup; app refuses to start with placeholder secrets outside `NODE_ENV=test`.
- Parameterised SQL only. No string-built SQL (whitelist sort columns if sorting is added).
- No stack traces in API responses in production mode; central error handler.
- pino `redact`: `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-provider-signature"]`, `*.password`, `*.token`, `*.secret`.
- Document limitations: no webhook timestamp replay window (next step: reject `occurredAt` older than 5 min + signed timestamp header), mock provider only, single instance, no refresh tokens/revocation, no secret rotation.

---

## 7. Frontend (web/) — merchant dashboard

**Use the installed skills** (ui-ux-pro-max, taste-skill, nextjs-best-practices, tailwind-css-coding, responsive-design, web-performance-optimization, animate, seo-expert). Read them before building UI and follow them, but this file wins if they conflict.

Design direction: a calm, trustworthy **fintech** dashboard. Neutral surfaces, one accent colour, status colours (success green, pending amber, failed red) with text labels (never colour alone), tabular numbers for amounts, light + dark mode, WCAG AA contrast, visible focus states, keyboard navigable.

Pages (App Router):
- `/login` — email/password form, inline errors, three "Use demo account" buttons that fill credentials (demo only).
- `/dashboard` — summary cards (Total payments, Total volume ₹, Success, Pending, Failed — counts + amounts), "Create test payment" dialog (amount in ₹ converted to paise, auto `Idempotency-Key` via `crypto.randomUUID()`), transaction table: reference, amount, status badge, created at, provider id. **Search** (debounced, by reference), **status filter**, **server-side pagination** (page + page size, URL query params so state survives refresh). Admin sees a merchant selector; merchants never do.
- `/payments/[id]` — details: amount, status, references, `needs_reconciliation` flag, **audit timeline** (from → to, source, time), **webhook events** list (event id, status, outcome, received at).
- States everywhere: **loading** (skeletons), **empty** ("No payments yet" + create button), **error** (message + Retry), **not found** (other merchant's id).

Technical:
- Next.js `rewrites` proxy `/api/:path*` → `API_URL` (default `http://localhost:4000`) so the httpOnly cookie works same-origin. No tokens in localStorage.
- `middleware.ts` redirects unauthenticated users to `/login`.
- TanStack Query for fetching (keepPreviousData for pagination), typed API client in `web/lib/api.ts`.
- Responsive: table → stacked cards under 640px; works at 360px width.
- Animations: subtle (fade/slide for cards, dialog, row hover); respect `prefers-reduced-motion`.
- Performance: server components where possible, no heavy chart libs unless needed, `next/font`, images optimised.
- SEO/metadata: proper titles/descriptions per page, favicon, **`robots: { index: false, follow: false }`** (private dashboard), `lang="en"`.
- Money formatting: `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })` from paise.

---

## 8. Tests (api/tests) — must all pass

Use a separate test database (`TEST_DATABASE_URL`); migrate once, truncate tables between tests. No random behaviour in tests (inject provider config). Required cases:

1. Valid webhook signature → 200, payment SUCCESS, 1 ledger entry.
2. Invalid signature → 401, **no** `webhook_events` row.
3. Missing signature → 401.
4. Body altered after signing → 401 (proves raw-body verification).
5. **Same SUCCESS event ×5 sequentially** → status changed once, 1 ledger entry, 1 SUCCESS audit row, 4 duplicates.
6. **Same SUCCESS event ×5 concurrently** (`Promise.all`) → same guarantees.
7. Two **different** event ids both SUCCESS concurrently → still 1 ledger entry.
8. Invalid transition (FAILED then SUCCESS) → 409, status stays FAILED, no ledger entry, `needs_reconciliation = true`.
9. Late PENDING after SUCCESS → 200 stale, status unchanged.
10. Merchant A cannot read Merchant B's payment (404) and list only returns own payments; merchant cannot call admin routes (403).
11. Idempotent initiation: same key + same body twice → 1 row, 2nd returns 200 replayed.
12. Same key + different body → 409.
13. Same key concurrently ×5 → exactly 1 row.
14. Validation: negative / zero / decimal / missing amount → 422; missing Idempotency-Key → 400.
15. Provider timeout on create → payment stays PENDING with `needs_reconciliation = true` (not FAILED).
16. Reconciliation: resolves PENDING when provider says SUCCESS (1 ledger entry), leaves it when provider times out, reports a mismatch without overwriting, and running it twice changes nothing.
17. Append-only: UPDATE/DELETE on `ledger_entries` and `payment_audit_log` raises.
18. State machine unit tests (full transition table).

`npm test` runs everything; `npm run test:report` writes verbose output to `docs/test-results.txt`.

---

## 9. Scripts (root package.json)

| Script | Does |
| --- | --- |
| `npm run db:up` / `db:down` | docker compose up -d --wait (blocks until the healthcheck passes) / down |
| `npm run migrate` / `migrate:test` | migrations on dev / test DB |
| `npm run seed` | seed demo data |
| `npm run dev` | API (4000) + web (3000) together (`concurrently`) |
| `npm test` | API test suite |
| `npm run test:report` | tests → `docs/test-results.txt` |
| `npm run simulate` | runs the webhook scenarios against the running API and prints a readable report |
| `npm run reconcile` | reconciliation CLI |
| `npm run lint` / `typecheck` | eslint + tsc --noEmit for both workspaces |

`scripts/simulate.ts` scenarios (print each step clearly — it is used in the walkthrough video):
1. Create a payment as Merchant A.
2. Send a valid SUCCESS webhook **5 times** sequentially, then 5 times concurrently for another payment → show 1 ledger entry each.
3. Send a late PENDING after SUCCESS → stale.
4. Send FAILED then SUCCESS for a third payment → 409.
5. Send a webhook with a bad signature → 401.
6. Delayed delivery (sleep then send).
7. Create a payment with the provider forced to time out → stays PENDING → run reconciliation → resolved from the mock provider status.

---

## 10. README.md (write it as you go, finish in the last phase)

Sections: Overview · Tech stack · Architecture (short diagram in Mermaid: web → api → postgres, mock provider, reconciliation) · **Setup** (Docker path + "any PostgreSQL" path, step by step, copy-paste commands) · Demo accounts · Environment variables table · API reference + **sample curl requests** (login, create payment with Idempotency-Key, signed webhook with how to compute the HMAC, list, reconcile) · How duplicates/concurrency are prevented (the three guards) · State machine table · Timeouts & reconciliation · Running tests + summary of results · Screenshots (from `docs/screenshots/`) · Key decisions · **Limitations & what I'd do next** · Assessment checklist mapping each requirement in the email to the file/test that covers it.

---

## 11. Definition of done (check before saying a phase is finished)

- [ ] `npm run typecheck` and `npm run lint` pass for api and web
- [ ] `npm test` passes; relevant new tests added for the phase
- [ ] No secrets in code, logs, or commits (`git grep -i secret` shows only env reads/placeholders)
- [ ] README updated for anything new (setup, endpoints, limitations)
- [ ] Committed with a clear message
