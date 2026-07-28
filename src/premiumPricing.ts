import { getEnv } from './env.js';

// Freemap Premium costs 8 €/year; on 1 September 2026 the price rises to
// 15 €/year for new customers. Polar keeps a running subscription on the price
// it was created with, so the switch is done by repointing
// `POLAR_PREMIUM_*_PRODUCT_ID` at the 15 € products on that day —
// `POLAR_PREMIUM_WINBACK_PRODUCT_ID` stays on the unlisted 8 € subscription,
// which is why it is configured separately.

/** Product for a checkout offered in the app: whatever we currently sell. */
export function getPremiumProductId(recurring: boolean): string {
  return getEnv(
    recurring
      ? 'POLAR_PREMIUM_RECURRING_PRODUCT_ID'
      : 'POLAR_PREMIUM_ONETIME_PRODUCT_ID',
  );
}

/**
 * Unlisted 8 €/year subscription sold only through the win-back offer;
 * `undefined` when it isn't configured. Never throws: a missing offer product
 * must not stop anyone from buying premium at the regular price.
 */
export function getWinbackProductId(): string | undefined {
  return getEnv('POLAR_PREMIUM_WINBACK_PRODUCT_ID', '') || undefined;
}

/** True for that product; false when it isn't configured (never throws). */
export function isWinbackProduct(
  productId: string | null | undefined,
): boolean {
  const winbackProductId = getWinbackProductId();

  return winbackProductId !== undefined && productId === winbackProductId;
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
      getEnv('POLAR_PREMIUM_WINBACK_PRODUCT_ID', ''),
    ].includes(productId)
  );
}
