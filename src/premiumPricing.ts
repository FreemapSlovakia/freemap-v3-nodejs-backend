import { getEnv } from './env.js';

// Freemap Premium costs 15 €/year. The price is raised on the Polar products
// themselves, so these IDs don't change; Polar grandfathers a running
// subscription onto the amount it was created at, and those renewals must keep
// provisioning.

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
