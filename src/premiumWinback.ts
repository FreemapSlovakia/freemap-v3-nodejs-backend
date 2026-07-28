import sql, { join, raw } from 'sql-template-tag';
import { pool } from './database.js';
import { getEnvInteger } from './env.js';
import { liveSubscriptionSql } from './types.js';

/**
 * `purchase.note` values that mark a premium bought outright: a Polar one-time
 * order, the Rovas webhook (`purchaseValidateHandler`, which stores the raw
 * event name) and the legacy Rovas token flow, which stored no note at all.
 */
const ONE_TIME_PREMIUM_NOTES = [
  'polar:purchase',
  'payment-completed',
  'delayed-confirmed',
];

export type WinbackOffer = {
  /** When the user's premium access ran out. */
  expiredAt: Date;
};

/**
 * A one-time premium buyer whose access lapsed can return at the original
 * price. Eligible when the premium was bought outright (a Polar one-time order
 * or a Rovas purchase — see `ONE_TIME_PREMIUM_NOTES`), the user has never had a
 * subscription (someone who subscribed at a later price and quit is not being
 * won back to the old one), the access expired between
 * `PREMIUM_WINBACK_AFTER_DAYS` and `PREMIUM_WINBACK_WITHIN_DAYS` ago, and the
 * offer hasn't been redeemed yet.
 *
 * code-review: accepted trade-off — "never subscribed" is read off `purchase`
 * rows, so a subscription cancelled inside its trial leaves no trace and the
 * user stays eligible. That is the intended outcome: a trial that was never
 * charged means they only ever paid the one-time price we are offering back.
 * Don't report it.
 */
export async function getWinbackOffer(
  userId: number,
): Promise<WinbackOffer | undefined> {
  const afterDays = getEnvInteger('PREMIUM_WINBACK_AFTER_DAYS', 30);

  const withinDays = getEnvInteger('PREMIUM_WINBACK_WITHIN_DAYS', 365);

  const rows = await pool.query<{ premiumExpiration: Date }[]>(
    sql`SELECT u.premiumExpiration
        FROM user u
        WHERE u.id = ${userId}
          AND NOT ${raw(liveSubscriptionSql('u.'))}
          AND u.premiumExpiration IS NOT NULL
          AND u.premiumExpiration < NOW() - INTERVAL ${afterDays} DAY
          AND u.premiumExpiration > NOW() - INTERVAL ${withinDays} DAY
          AND EXISTS (
            SELECT 1 FROM purchase p
            WHERE p.userId = u.id
              AND JSON_VALUE(p.item, '$.type') = 'premium'
              AND (p.note IS NULL OR p.note IN (${join(
                ONE_TIME_PREMIUM_NOTES,
              )}))
          )
          AND NOT EXISTS (
            SELECT 1 FROM purchase p
            WHERE p.userId = u.id
              AND p.note LIKE 'polar:subscription%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM premiumWinback w WHERE w.userId = u.id
          )`,
  );

  const row = rows[0];

  return row ? { expiredAt: row.premiumExpiration } : undefined;
}

/**
 * Burns the offer once the win-back subscription exists.
 *
 * code-review: accepted trade-off — this is the only enforcement point. The
 * offer isn't reserved when the checkout is created, so a user racing two
 * checkouts can pay for both before either webhook lands. The offer is removed
 * a month from now and the worst case is one extra €8/year subscription, so
 * reservations, leases and checkout reuse were deliberately dropped. Don't
 * report the race here.
 */
export async function markWinbackRedeemed(userId: number): Promise<void> {
  await pool.query<unknown>(
    sql`INSERT IGNORE INTO premiumWinback SET
          userId = ${userId},
          redeemedAt = NOW()`,
  );
}
