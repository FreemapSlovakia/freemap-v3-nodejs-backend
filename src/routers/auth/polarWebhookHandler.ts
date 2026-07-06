import type { RouterInstance } from '@koa/router';
import {
  validateEvent,
  WebhookVerificationError,
} from '@polar-sh/sdk/webhooks';
import sql from 'sql-template-tag';
import { pool, runInTransaction } from '../../database.js';
import { getEnv } from '../../env.js';
import { registerPath } from '../../openapi.js';

type MetaValue = string | number | boolean;

function metaString(
  metadata: Record<string, MetaValue> | undefined | null,
  key: string,
): string | undefined {
  const value = metadata?.[key];

  return value === undefined ? undefined : String(value);
}

/** Resolve our user ID from event metadata, falling back to the customer's external ID. */
function resolveUserId(
  metadata: Record<string, MetaValue> | undefined | null,
  externalId: string | null | undefined,
): number | undefined {
  const raw = metaString(metadata, 'userId') ?? externalId ?? undefined;

  if (raw === undefined) {
    return undefined;
  }

  const id = Number(raw);

  return Number.isInteger(id) && id > 0 ? id : undefined;
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

        const userId = resolveUserId(order.metadata, order.customer.externalId);

        if (userId === undefined) {
          ctx.log.warn(
            { orderId: order.id },
            'Polar order without resolvable user',
          );

          break;
        }

        // Classify the order by product (authoritative; metadata is a fallback):
        //  - credits          → add to the credit balance
        //  - one-time premium → extend premiumExpiration by 1 year
        //  - recurring premium order (subscription create/renewal) → history
        //    only; access is provisioned by the subscription.* events.
        const isCredits =
          order.productId === getEnv('POLAR_CREDITS_PRODUCT_ID') ||
          metaString(order.metadata, 'kind') === 'credits';

        const isOneTimePremium =
          order.productId === getEnv('POLAR_PREMIUM_ONETIME_PRODUCT_ID');

        // For credits, the chosen count equals the net (pre-tax) amount in euro
        // cents; prefer the explicit metadata value when present.
        const credits = isCredits
          ? Number(metaString(order.metadata, 'credits') ?? order.netAmount)
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
              note = ${'polar:' + order.billingReason},
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

      case 'subscription.active':
      case 'subscription.updated':
      case 'subscription.uncanceled':
      case 'subscription.canceled': {
        // `canceled` keeps access until the period end, so we still provision up
        // to `currentPeriodEnd`.
        const sub = event.data;

        const userId = resolveUserId(sub.metadata, sub.customer.externalId);

        if (userId === undefined) {
          ctx.log.warn(
            { subscriptionId: sub.id },
            'Polar subscription without resolvable user',
          );

          break;
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

        break;
      }

      case 'subscription.revoked': {
        // The subscription ended. We only detach it here; `premiumExpiration`
        // already reflects the last (now-past) period end set on active/updated.
        // We deliberately don't force it to NOW(): during the migration that
        // could wipe premium granted by another source (e.g. legacy Rovas).
        const sub = event.data;

        const userId = resolveUserId(sub.metadata, sub.customer.externalId);

        if (userId !== undefined) {
          await pool.query<unknown>(
            sql`UPDATE user SET polarSubscriptionId = NULL
                WHERE id = ${userId} AND polarSubscriptionId = ${sub.id}`,
          );
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
