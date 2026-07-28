import { getEnv } from './env.js';

// Freemap Premium costs 8 €/year; on 1 September 2026 the price rises to
// 15 €/year for new customers. Polar keeps a running subscription on the price
// it was created with, so the switch is done by repointing
// `POLAR_PREMIUM_*_PRODUCT_ID` at the 15 € products on that day.

/** Product for a checkout offered in the app: whatever we currently sell. */
export function getPremiumProductId(recurring: boolean): string {
  return getEnv(
    recurring
      ? 'POLAR_PREMIUM_RECURRING_PRODUCT_ID'
      : 'POLAR_PREMIUM_ONETIME_PRODUCT_ID',
  );
}

/** True for any product premium is sold through (never throws). */
export function isPremiumProduct(
  productId: string | null | undefined,
): boolean {
  return (
    productId != null &&
    [
      getEnv('POLAR_PREMIUM_RECURRING_PRODUCT_ID', ''),
      getEnv('POLAR_PREMIUM_ONETIME_PRODUCT_ID', ''),
    ].includes(productId)
  );
}
