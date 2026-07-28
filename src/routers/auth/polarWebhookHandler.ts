import type { RouterInstance } from '@koa/router';
import {
  validateEvent,
  WebhookVerificationError,
} from '@polar-sh/sdk/webhooks';
import sql from 'sql-template-tag';
import { pool, runInTransaction } from '../../database.js';
import { getEnv } from '../../env.js';
import { registerPath } from '../../openapi.js';
import { isPremiumProduct, isWinbackProduct } from '../../premiumPricing.js';
import { markWinbackRedeemed } from '../../premiumWinback.js';

/**
 * Subscription statuses that provision nothing, because the period they carry
 * hasn't been paid for.
 *
 * Polar advances `currentPeriodEnd` at the cycle boundary, *before* the renewal
 * payment settles, and always emits a `subscription.updated` alongside the
 * status change. So a `past_due` subscription arrives holding a period end a
 * year ahead that nobody has paid — and since `subscription.revoked`
 * deliberately never shortens `premiumExpiration`, granting it would mean a
 * free year for anyone whose card fails. `incomplete*` is the same story for a
 * first payment; trials are `trialing`, not `incomplete`, so they're unaffected.
 *
 * It also keeps the single-use win-back offer from being burned by a
 * subscription that was never paid for, which would leave the user unable to
 * take the offer again.
 *
 * Nothing is lost by waiting: a late payment re-activates the subscription,
 * which provisions the period then. The cost is that access lapses during
 * Polar's grace window instead of being carried through it.
 */
const UNPAID_STATUSES = new Set([
  'incomplete',
  'incomplete_expired',
  'past_due',
  'unpaid',
]);

type MetaValue = string | number | boolean;

function metaString(
  metadata: Record<string, MetaValue> | undefined | null,
  key: string,
): string | undefined {
  const value = metadata?.[key];

  return value === undefined ? undefined : String(value);
}

/**
 * Resolve our user ID from event metadata, falling back to the customer's
 * external ID and finally to the stored `polarCustomerId`. That last step
 * matters after an account merge: metadata and external ID still name the
 * account that was merged away, and without it renewals for the surviving user
 * would silently provision nothing.
 */
async function resolveUserId(
  metadata: Record<string, MetaValue> | undefined | null,
  customer: { id: string; externalId?: string | null },
): Promise<number | undefined> {
  const raw =
    metaString(metadata, 'userId') ?? customer.externalId ?? undefined;

  if (raw !== undefined) {
    const id = Number(raw);

    if (Number.isInteger(id) && id > 0) {
      const rows = await pool.query<{ id: number }[]>(
        sql`SELECT id FROM user WHERE id = ${id}`,
      );

      if (rows.length > 0) {
        return id;
      }
    }
  }

  const rows = await pool.query<{ id: number }[]>(
    sql`SELECT id FROM user WHERE polarCustomerId = ${customer.id} LIMIT 1`,
  );

  return rows[0]?.id;
}

/** Detaches a finished subscription, unless a newer one took its place. */
async function clearSubscription(
  userId: number,
  subscriptionId: string,
): Promise<void> {
  await pool.query<unknown>(
    sql`UPDATE user SET polarSubscriptionId = NULL
        WHERE id = ${userId} AND polarSubscriptionId = ${subscriptionId}`,
  );
}

export function attachPolarWebhookHandler(router: RouterInstance) {
  registerPath('/auth/polar/webhook', {
    post: {
      summary: 'Polar webhook to provision premium access and credits',
      tags: ['auth'],
      responses: { 204: {}, 400: {}, 403: {} },
    },
  });

  router.post('/polar/webhook', async (ctx) => {
    // Raw, unparsed body is required for signature verification; koa-body is
    // configured with `includeUnparsed` so it's available here.
    const rawBody = ctx.request.rawBody;

    if (rawBody === undefined) {
      return ctx.throw(400, 'missing request body');
    }

    let event;

    try {
      event = validateEvent(
        rawBody,
        ctx.headers as Record<string, string>,
        getEnv('POLAR_WEBHOOK_SECRET'),
      );
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return ctx.throw(403, 'invalid signature');
      }

      return ctx.throw(400, err as Error);
    }

    switch (event.type) {
      case 'order.paid': {
        const order = event.data;

        const userId = await resolveUserId(order.metadata, order.customer);

        if (userId === undefined) {
          ctx.log.warn(
            { orderId: order.id },
            'Polar order without resolvable user',
          );

          break;
        }

        // Classify the order:
        //  - credits           → add to the credit balance
        //  - one-time premium  → extend premiumExpiration by 1 year
        //  - subscription order (create/renewal) → history only; access is
        //    provisioned by the subscription.* events
        //  - anything else (a donation, a manual order, an unknown product) →
        //    ignored; guessing premium here would hand out a free year.
        const kind = metaString(order.metadata, 'kind');

        const isCredits =
          order.productId === getEnv('POLAR_CREDITS_PRODUCT_ID', '') ||
          kind === 'credits';

        // Our own checkouts always carry `kind`; the product IDs are the
        // fallback for orders created outside them (e.g. in the Polar UI).
        const isPremium =
          !isCredits &&
          (kind === 'premium' || isPremiumProduct(order.productId));

        // Subscriptions only ever sell premium here, and a renewal order may
        // arrive without the checkout metadata, so those count as premium
        // history regardless — they grant nothing on their own anyway.
        const isSubscriptionOrder = order.subscriptionId !== null;

        if (!isCredits && !isPremium && !isSubscriptionOrder) {
          ctx.log.warn(
            { orderId: order.id, productId: order.productId },
            'unrecognized Polar order; nothing provisioned',
          );

          break;
        }

        const isOneTimePremium = isPremium && !isSubscriptionOrder;

        // For credits, the chosen count is what the buyer was charged in euro
        // cents, which is `subtotalAmount`: our prices are tax-inclusive, so a
        // 500-credit order reads subtotal 500, tax 93, net 407. Using the net
        // here would short-change the buyer by the tax. Metadata is set by our
        // own checkout and wins; this only covers orders made elsewhere.
        const credits = isCredits
          ? Number(
              metaString(order.metadata, 'credits') ?? order.subtotalAmount,
            )
          : null;

        await runInTransaction(async (conn) => {
          // Record the order idempotently; the unique `polarOrderId` constraint
          // means a redelivered webhook inserts nothing and grants nothing.
          const res = await conn.query<{ affectedRows: number }>(
            sql`INSERT IGNORE INTO purchase SET
              userId = ${userId},
              item = ${JSON.stringify(
                isCredits
                  ? { type: 'credits', amount: credits }
                  : { type: 'premium' },
              )},
              createdAt = NOW(),
              note = ${`polar:${order.billingReason}`},
              polarOrderId = ${order.id}`,
          );

          // Grant only when the row was newly inserted (so redelivery is safe).
          if (res.affectedRows !== 1) {
            return;
          }

          if (isCredits) {
            await conn.query<unknown>(
              sql`UPDATE user
                  SET credits = credits + ${credits},
                      email = COALESCE(email, ${order.customer.email})
                  WHERE id = ${userId}`,
            );
          } else if (isOneTimePremium) {
            // Add a year from whichever is later — now or any existing premium
            // (never shortens premium granted elsewhere); stacks on repeat buys.
            await conn.query<unknown>(
              sql`UPDATE user
                  SET premiumExpiration =
                        GREATEST(COALESCE(premiumExpiration, NOW()), NOW())
                          + INTERVAL 1 YEAR,
                      email = COALESCE(email, ${order.customer.email})
                  WHERE id = ${userId}`,
            );
          }
        });

        break;
      }

      case 'subscription.created':
      case 'subscription.active':
      case 'subscription.updated':
      case 'subscription.uncanceled':
      case 'subscription.canceled': {
        // `created` matters because a subscription that starts as a trial stays
        // `trialing` (up to a year for us) and never fires `active` in the
        // meantime — without it `polarSubscriptionId` would stay unset for the
        // whole trial, so the app would keep offering a second subscription.
        // `canceled` keeps access until the period end, so we still provision up
        // to `currentPeriodEnd`.
        const sub = event.data;

        if (UNPAID_STATUSES.has(sub.status)) {
          break;
        }

        const userId = await resolveUserId(sub.metadata, sub.customer);

        if (userId === undefined) {
          ctx.log.warn(
            { subscriptionId: sub.id },
            'Polar subscription without resolvable user',
          );

          break;
        }

        // A subscription that has already ended must not re-take the stored ID:
        // Polar also sends an `updated` for the status change around revocation
        // and delivery isn't ordered, so a late one would leave the user marked
        // as subscribed. Let the end win.
        //
        // `endedAt` is the right test, not `canceled`/`endsAt`: Polar sets it
        // only when access is actually over — an immediate revoke, or the cycle
        // that finds `cancel_at_period_end` set — and clears it on reactivation.
        // Cancelling with time left on the period leaves it null, so this does
        // not cut anyone's premium short.
        //
        // code-review: accepted trade-off — this only catches snapshots that
        // already know they ended. A snapshot taken *before* revocation and
        // retried after it still carries `endedAt: null` and re-stores the ID.
        // That's inert: `premiumExpiration` is never shortened here, so the
        // dead ID comes with an expired premium, and every consumer goes
        // through `liveSubscriptionSql`, which requires both. Ordering this
        // properly would mean persisting `modifiedAt` per subscription; not
        // worth it for a stale value nothing reads. Don't report it.
        if (sub.endedAt !== null) {
          await clearSubscription(userId, sub.id);

          break;
        }

        // The checkout refuses to start a second subscription, but that check
        // can't bind two checkouts created before either was paid. Only one ID
        // can be stored, so the older subscription becomes invisible here —
        // including to `subscription.revoked`, which matches on the stored ID.
        // Nothing here can cancel it in Polar, so say so loudly.
        //
        // code-review: accepted trade-off — the checkout's guard is
        // check-then-act by nature and a webhook can't stop Polar from holding
        // two subscriptions. Logging the orphan is the whole remedy; don't
        // report the race or ask for locking.
        const previous = await pool.query<{ polarSubscriptionId: string }[]>(
          sql`SELECT polarSubscriptionId FROM user
              WHERE id = ${userId}
                AND polarSubscriptionId IS NOT NULL
                AND polarSubscriptionId <> ${sub.id}`,
        );

        if (previous.length > 0) {
          ctx.log.warn(
            {
              userId,
              orphanedSubscriptionId: previous[0]?.polarSubscriptionId,
              subscriptionId: sub.id,
            },
            'user has a second Polar subscription; cancel the orphaned one manually',
          );
        }

        // Never shorten premium granted by another source (e.g. legacy Rovas)
        // while both flows run in parallel: extend to the later of the two.
        await pool.query<unknown>(
          sql`UPDATE user SET
              premiumExpiration = GREATEST(
                COALESCE(premiumExpiration, ${sub.currentPeriodEnd}),
                ${sub.currentPeriodEnd}
              ),
              polarSubscriptionId = ${sub.id},
              polarCustomerId = ${sub.customerId},
              email = COALESCE(email, ${sub.customer.email})
              WHERE id = ${userId}`,
        );

        // The win-back offer is single-use: burn it as soon as the discounted
        // subscription exists, so it can't be taken again after this one ends.
        if (
          isWinbackProduct(sub.productId) ||
          metaString(sub.metadata, 'winback') === 'true'
        ) {
          await markWinbackRedeemed(userId);
        }

        break;
      }

      case 'subscription.revoked': {
        // The subscription ended. We only detach it here; `premiumExpiration`
        // already reflects the last (now-past) period end set on active/updated.
        // We deliberately don't force it to NOW(): during the migration that
        // could wipe premium granted by another source (e.g. legacy Rovas).
        const sub = event.data;

        const userId = await resolveUserId(sub.metadata, sub.customer);

        if (userId !== undefined) {
          await clearSubscription(userId, sub.id);
        }

        break;
      }

      default:
        // Ignore unrelated events.
        break;
    }

    ctx.status = 204;
  });
}
