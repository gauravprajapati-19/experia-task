import { z } from 'zod';

/** ₹1 crore cap on a single payment (documented in the README). Amounts are always integer paise. */
export const MAX_AMOUNT_PAISE = 1_000_000_000;

// int() already rejects decimals and anything outside the safe-integer range; the cap keeps sums far from it too
export const amountPaiseSchema = z
  .number()
  .int('amountPaise must be an integer number of paise')
  .positive('amountPaise must be greater than 0')
  .max(MAX_AMOUNT_PAISE, 'amountPaise must not exceed 1000000000 (₹1 crore)');
