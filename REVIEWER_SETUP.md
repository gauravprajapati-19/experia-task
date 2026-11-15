# Reviewer setup

A step-by-step guide to running and checking this project on your own machine. It takes about 10 minutes and assumes no prior context. The full design write-up is in the [README](README.md).

## 1. Prerequisites

- **Node.js 20 LTS, version 20.19 or newer** (includes npm): <https://nodejs.org/en/download>. Check with `node -v`.
- **Git**: <https://git-scm.com/downloads>.

You do **not** need PostgreSQL or Docker. The project uses a hosted **Neon PostgreSQL** database: one database for the app and a separate one for the tests.

The connection strings for both databases, and the other settings, are in **`reviewer.env.txt`**, which was sent to you by email. It is not in the repository. Save it as **`.env`** in the project root (step 2 below).

## 2. Run it

Commands work in PowerShell, Git Bash, macOS and Linux terminals unless marked.

```bash
# 1. Get the code
git clone https://github.com/gauravprajapati-19/experia-task.git experia-task
cd experia-task

# 2. Put the emailed file in place as .env (adjust the path to where you saved it)
cp ~/Downloads/reviewer.env.txt .env                          # Git Bash / macOS / Linux
# Copy-Item "$HOME\Downloads\reviewer.env.txt" .env           # PowerShell

# 3. Install dependencies (both workspaces: api and web)
npm install

# 4. Create the schema (safe to re-run) and load demo data
npm run migrate
npm run seed

# 5. Start the API and the dashboard together (leave this terminal running)
npm run dev
```

- Dashboard: <http://localhost:3000>
- API: <http://localhost:4000> (health check: <http://localhost:4000/api/health> returns `{"ok":true,"db":true}`)

Open a **second terminal** in the same folder for the rest:

```bash
npm test              # full API test suite (131 tests) against the TEST database only
npm run simulate      # needs npm run dev running: 7 webhook/reliability scenarios, each PASS/FAIL
npm run reconcile     # needs npm run dev running: reconciliation report (resolved / mismatches / unresolved)
```

## 3. Demo logins

| Email | Role |
| --- | --- |
| `merchant.a@experia.test` | Merchant A (Nova Retail) |
| `merchant.b@experia.test` | Merchant B (Orbit Foods) |
| `admin@experia.test` | Admin (all merchants) |

The password for all three is the value of `SEED_DEMO_PASSWORD` in your `.env`. On the login page, the **Use demo account** buttons fill in the email and password for you.

All data is synthetic. There are no real customers, credentials or money.

## 4. What to test

| # | Do this | Expected result |
| --- | --- | --- |
| 1 | Log in as `merchant.a@experia.test`. Then try a wrong password. | The dashboard opens. A wrong password shows "Invalid email or password". |
| 2 | On the dashboard, use the status filter, the search box (type part of a `PAY_` reference), the page size and Next/Previous. Refresh the page. | The table updates from the server, and the filter and page survive a refresh because they are in the URL. The summary cards show counts and ₹ totals per status. |
| 3 | Click **Create test payment** and enter an amount, for example 499. | A new **PENDING** payment appears at the top of the list. It stays PENDING until the simulated provider sends a webhook (see the README, "Timeouts, retries and reconciliation"). |
| 4 | Run `npm run simulate`. In its output, copy the reference from scenario 2 ("sent 5 times SEQUENTIALLY") and search for it on the dashboard. Open it. | Status **SUCCESS**. Webhook events show **"5 deliveries received · 1 applied · 4 duplicates"**. The audit timeline has exactly one `PENDING → SUCCESS` entry. All 7 scenarios print PASS. |
| 5 | Open any payment as Merchant A and copy the page URL. Log out, log in as `merchant.b@experia.test` and open that URL. | **Payment not found**. Another merchant's payment returns 404, so its existence is not leaked. Merchant B's list shows only Orbit Foods payments. |
| 6 | Log in as `admin@experia.test`. | A **merchant selector** appears, showing all merchants or one at a time. Merchants never see it. The admin has no "Create test payment" button. |
| 7 | Send a webhook with a bad signature (commands below). | **401** `INVALID_SIGNATURE`, and nothing is stored. The README's [Sample curl requests](README.md#sample-curl-requests) section also shows a correctly signed webhook and a tampered body that gets 401. |
| 8 | Run `npm run reconcile`, then run it again. | A table of resolved / mismatches / unresolved payments. The seed includes deliberate conflicts that are **reported, not overwritten**. The second run resolves nothing new and adds no ledger entries. |
| 9 | Open a payment that shows the "Needs reconciliation" flag (filter **Pending**, or use one listed by `npm run reconcile`). | The details page shows the flag, the audit timeline and the webhook events. |
| 10 | Narrow the browser to phone width (DevTools device toolbar, about 360 px). | The table turns into stacked cards. There is no horizontal scrolling, and the create dialog still works. |

**Bad-signature webhook (check 7).** Run this with `npm run dev` running.

Git Bash, macOS or Linux:

```bash
curl -s -i -X POST http://localhost:4000/api/webhooks/payment-provider \
  -H 'Content-Type: application/json' -H 'X-Provider-Signature: deadbeef' \
  --data-raw '{"eventId":"evt_bad_sig","paymentReference":"PAY_X","status":"SUCCESS","occurredAt":"2026-11-15T10:00:00Z"}'
```

PowerShell:

```powershell
try {
  Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/webhooks/payment-provider `
    -ContentType 'application/json' -Headers @{ 'X-Provider-Signature' = 'deadbeef' } `
    -Body '{"eventId":"evt_bad_sig","paymentReference":"PAY_X","status":"SUCCESS","occurredAt":"2026-11-15T10:00:00Z"}'
} catch { $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```

The response is `401` with `{"error":{"code":"INVALID_SIGNATURE",...}}`.

## 5. Troubleshooting

- **Port 3000 or 4000 already in use.** Stop the other program, or find and end the process:
  - Windows: `netstat -ano | findstr :4000`, then `taskkill /PID <pid> /F`
  - macOS/Linux: `lsof -i :4000`, then `kill <pid>`
- **Wrong Node version.** `node -v` must be **20.19 or newer**. Older versions fail during `npm install` or when running the tests.
- **`npm run seed` resets the demo data.** It deletes and recreates every payment in the app database, including ones you created. Run it again at any time to get back to a clean state.
- **Tests only touch the TEST database.** `npm test` runs against `TEST_DATABASE_URL` and truncates its tables. It never touches the app database, and both the test runner and the seed refuse to run if the two URLs point at the same database.
- **Warnings during `npm install`.** A deprecation notice for ESLint 9 and a few moderate `npm audit` advisories in development tooling are expected and harmless. See the README's [Limitations](README.md#limitations--what-id-do-next).
- **The API refuses to start.** `.env` is missing or is not in the project root. It must be named exactly `.env`, not `.env.txt`. On Windows, check that File Explorer has not hidden the extension.
- **The first request is slow.** The hosted database may take a second or two to wake up after being idle.

## Optional: run with your own database

To use a local Docker PostgreSQL instead of the hosted one, follow the README's [Option A: Docker](README.md#option-a-docker-recommended-for-reviewers).
