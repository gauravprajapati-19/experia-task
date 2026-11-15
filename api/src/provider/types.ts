import type { PaymentStatus } from '../payments/types.js';

/**
 * result of a call to the payment provider. A timeout is NOT a failure: the provider may have
 * processed the request, so callers must treat `timeout` as "outcome unknown".
 */
export type ProviderResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'timeout'; message: string }
  | { kind: 'error'; message: string };

export interface ProviderRegistration {
  providerPaymentId: string;
}

/** the provider's own view of a payment (what reconciliation compares against) */
export interface ProviderPaymentStatus {
  providerPaymentId: string;
  reference: string;
  amountPaise: number;
  status: PaymentStatus;
}

export interface PaymentProvider {
  registerPayment(input: { reference: string; amountPaise: number }): Promise<ProviderResult<ProviderRegistration>>;
}

/** what reconciliation needs from the provider. `ok` with `null` means the provider has no record. */
export interface ProviderStatusReader {
  getPayment(reference: string): Promise<ProviderResult<ProviderPaymentStatus | null>>;
}
