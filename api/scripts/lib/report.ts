// colour only when writing to a terminal, and never when NO_COLOR is set
import { pool } from '../../src/db/pool.js';

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColour ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');
export const cyan = paint('36');

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
export const formatPaise = (paise: number) => rupees.format(paise / 100);

export function banner(title: string, subtitle?: string): void {
  const line = '='.repeat(Math.max(64, title.length + 4));
  console.log(`\n${cyan(line)}\n  ${bold(title)}${subtitle ? `\n  ${dim(subtitle)}` : ''}\n${cyan(line)}`);
}

export function heading(title: string): void {
  console.log(`\n${bold(cyan(`--- ${title} `.padEnd(64, '-')))}`);
}

export function step(text: string): void {
  console.log(`  ${dim('>')} ${text}`);
}

export function note(text: string): void {
  console.log(`    ${dim(text)}`);
}

export function check(passed: boolean, label: string): boolean {
  console.log(`  ${passed ? green('[PASS]') : red('[FAIL]')} ${label}`);
  return passed;
}

type Cell = string | number | boolean | null | undefined;

/** column order comes from the first row */
export function table(rows: Record<string, Cell>[], indent = '  '): void {
  if (rows.length === 0) {
    console.log(`${indent}${dim('(none)')}`);
    return;
  }
  const columns = Object.keys(rows[0]!);
  const text = (value: Cell) => (value === null || value === undefined ? '-' : String(value));
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => text(row[col]).length)));
  const format = (cells: string[]) => indent + cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
  console.log(bold(format(columns)));
  console.log(indent + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(format(columns.map((col) => text(row[col]))));
}

/** whole-database totals, printed at the end of both scripts */
export async function printDatabaseTotals(): Promise<void> {
  const { rows } = await pool.query<{ status: string; count: number; amount: string }>(
    `SELECT status, count(*)::int AS count, coalesce(sum(amount_paise), 0)::text AS amount
     FROM payments GROUP BY status ORDER BY status`,
  );
  const totals = await pool.query<{ flagged: number; ledger: number; ledger_amount: string; events: number; runs: number }>(
    `SELECT (SELECT count(*)::int FROM payments WHERE needs_reconciliation) AS flagged,
            (SELECT count(*)::int FROM ledger_entries) AS ledger,
            (SELECT coalesce(sum(amount_paise), 0)::text FROM ledger_entries) AS ledger_amount,
            (SELECT count(*)::int FROM webhook_events) AS events,
            (SELECT count(*)::int FROM reconciliation_runs) AS runs`,
  );
  const t = totals.rows[0]!;
  table(rows.map((r) => ({ status: r.status, payments: r.count, amount: formatPaise(Number(r.amount)) })));
  console.log();
  table([
    {
      'needs reconciliation': t.flagged,
      'ledger entries': t.ledger,
      'captured amount': formatPaise(Number(t.ledger_amount)),
      'webhook events': t.events,
      'reconciliation runs': t.runs,
    },
  ]);
}
