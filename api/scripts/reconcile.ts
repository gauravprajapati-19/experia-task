/**
 * `npm run reconcile [-- --older-than=<minutes> --limit=<n>]`
 * Compares PENDING / flagged payments with the mock provider (which must be running: `npm run dev`)
 * and prints what was resolved, what disagrees, and what is still unknown.
 */
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { createProviderClient } from '../src/provider/providerClient.js';
import { reconcile } from '../src/reconciliation/service.js';
import { banner, bold, formatPaise, green, heading, printDatabaseTotals, red, table, yellow } from './lib/report.js';

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

async function main(): Promise<void> {
  const options = { olderThanMinutes: numberArg('older-than', 0), limit: numberArg('limit', 200) };
  banner('Reconciliation', `provider: ${config.PROVIDER_BASE_URL}  |  older than ${options.olderThanMinutes} min  |  limit ${options.limit}`);

  const client = createProviderClient({ baseUrl: config.PROVIDER_BASE_URL, timeoutMs: config.PROVIDER_TIMEOUT_MS });
  const report = await reconcile(client, options);

  const merchants = await pool.query<{ id: string; name: string }>('SELECT id, name FROM merchants');
  const merchantName = (id: string) => merchants.rows.find((m) => m.id === id)?.name ?? id;

  heading(`Resolved (${report.resolved.length})`);
  table(
    report.resolved.map((r) => ({
      reference: r.reference,
      merchant: merchantName(r.merchantId),
      change: r.from === r.to ? `${r.to} (confirmed)` : `${r.from} -> ${r.to}`,
      action: r.action,
    })),
  );

  heading(`Mismatches: reported, NOT overwritten (${report.mismatches.length})`);
  table(
    report.mismatches.map((m) => ({
      reference: m.reference,
      merchant: merchantName(m.merchantId),
      reason: m.reason,
      ours: m.reason === 'amount' ? formatPaise(m.internalAmountPaise) : m.internalStatus,
      provider: m.reason === 'amount' ? formatPaise(m.providerAmountPaise) : m.providerStatus,
    })),
  );

  heading(`Unresolved: left untouched (${report.unresolved.length})`);
  table(
    report.unresolved.map((u) => ({
      reference: u.reference,
      merchant: merchantName(u.merchantId),
      status: u.status,
      reason: u.reason,
      detail: u.detail,
    })),
  );
  if (report.unresolved.length > 0 && report.unresolved.every((u) => u.reason === 'provider_error')) {
    console.log(`\n  ${yellow('Every lookup failed. Is the API (and its mock provider) running? Start it with `npm run dev`.')}`);
  }

  heading('Summary');
  console.log(
    `  run ${bold(report.runId)}\n` +
      `  checked ${bold(String(report.checked))}  |  ${green(`resolved ${report.resolved.length}`)}  |  ` +
      `${red(`mismatches ${report.mismatches.length}`)}  |  ${yellow(`unresolved ${report.unresolved.length}`)}\n`,
  );
  await printDatabaseTotals();
  console.log();
}

main()
  .catch((err: unknown) => {
    console.error(red(`Reconciliation failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
