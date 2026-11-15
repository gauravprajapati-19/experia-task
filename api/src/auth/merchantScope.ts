import { forbidden } from '../lib/errors.js';
import type { AuthContext } from './types.js';

/**
 * which merchant's data a request may touch.
 * - merchant users: ALWAYS the merchant from their JWT; any merchantId in the request is ignored.
 * - admins: the optional `requestedMerchantId` filter, or null meaning "all merchants".
 */
export function resolveMerchantScope(auth: AuthContext, requestedMerchantId?: string): string | null {
  if (auth.role === 'merchant') {
    if (!auth.merchantId) throw forbidden(); // unreachable: the users table requires merchant_id for merchants
    return auth.merchantId;
  }
  return requestedMerchantId ?? null;
}
