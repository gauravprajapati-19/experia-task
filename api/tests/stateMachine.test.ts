import { describe, expect, it } from 'vitest';
import { decideTransition, isTerminal, type TransitionDecision } from '../src/domain/stateMachine.js';
import type { PaymentStatus } from '../src/payments/types.js';

// Test 18: the full transition table from CLAUDE.md 6.4 (every from x to pair).
const table: [from: PaymentStatus, to: PaymentStatus, expected: TransitionDecision][] = [
  ['PENDING', 'PENDING', 'stale'],
  ['PENDING', 'SUCCESS', 'apply'],
  ['PENDING', 'FAILED', 'apply'],
  ['SUCCESS', 'PENDING', 'stale'],
  ['SUCCESS', 'SUCCESS', 'stale'],
  ['SUCCESS', 'FAILED', 'invalid'],
  ['FAILED', 'PENDING', 'stale'],
  ['FAILED', 'FAILED', 'stale'],
  ['FAILED', 'SUCCESS', 'invalid'],
];

describe('test 18: state machine', () => {
  it.each(table)('%s -> %s is %s', (from, to, expected) => {
    expect(decideTransition(from, to)).toBe(expected);
  });

  it('covers all 9 combinations exactly once', () => {
    expect(new Set(table.map(([from, to]) => `${from}->${to}`)).size).toBe(9);
  });

  it('treats SUCCESS and FAILED as terminal, PENDING as not', () => {
    expect(isTerminal('SUCCESS')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('PENDING')).toBe(false);
  });
});
