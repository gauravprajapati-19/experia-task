const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const dateTimeSeconds = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });

/** money is integer paise everywhere; it becomes rupees only here, for display */
export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}

export function formatDateTime(iso: string, withSeconds = false): string {
  return (withSeconds ? dateTimeSeconds : dateTime).format(new Date(iso));
}

/** ₹1 crore, the same cap the API enforces */
export const MAX_AMOUNT_PAISE = 1_000_000_000;

/** parses "1,250.5" into integer paise without ever going through a float */
export function rupeesToPaise(input: string): { paise: number } | { error: string } {
  const text = input.replace(/[,\s]/g, '').replace(/^₹/, '');
  if (text === '') return { error: 'Enter an amount.' };
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return { error: 'Use a number with at most 2 decimal places, e.g. 1250.50.' };

  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (paise <= 0) return { error: 'The amount must be more than ₹0.' };
  if (paise > MAX_AMOUNT_PAISE) return { error: 'The maximum is ₹1,00,00,000 (₹1 crore).' };
  return { paise };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
