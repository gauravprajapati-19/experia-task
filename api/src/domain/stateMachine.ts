import type { PaymentStatus } from '../payments/types.js';

/**
 * what to do when an event says a payment is now `to` while it is currently `from` (CLAUDE.md 6.4).
 * - apply:   PENDING -> SUCCESS / FAILED, the only real transitions
 * - stale:   nothing to do (repeat of the current state, or a late PENDING after a final state)
 * - invalid: contradicts a final state (SUCCESS <-> FAILED); never applied, flagged for reconciliation
 */
export type TransitionDecision = 'apply' | 'stale' | 'invalid';

const TERMINAL: ReadonlySet<PaymentStatus> = new Set(['SUCCESS', 'FAILED']);

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL.has(status);
}

export function decideTransition(from: PaymentStatus, to: PaymentStatus): TransitionDecision {
  if (from === to) return 'stale'; // PENDING again, or the same final status re-sent (any event id)
  if (from === 'PENDING') return 'apply'; // to is SUCCESS or FAILED
  if (to === 'PENDING') return 'stale'; // late / out-of-order PENDING after a final state
  return 'invalid'; // SUCCESS -> FAILED or FAILED -> SUCCESS: final states never change
}
