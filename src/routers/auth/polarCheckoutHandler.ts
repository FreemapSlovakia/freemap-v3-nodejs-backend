import type { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { getPolar } from '../../polar.js';
import { getPremiumProductId } from '../../premiumPricing.js';
import { liveSubscriptionSql } from '../../types.js';

// 1 credit = €0.01, so the chosen credit count equals the amount in euro cents.
const MIN_CREDITS = 500;

/** Longest trial we ask Polar for; see where it's clamped. */
const MAX_TRIAL_DAYS = 730;

const BodySchema = z.union([
  z.strictObject({
    type: z.literal('premium'),
    successUrl: z.url(),
    // true = auto-renewing yearly subscription; false = one-time year.
    recurring: z.boolean(),
    // Optional UI language for the checkout (e.g. 'sk', 'en').
    lang: z.string().max(10).optional(),
  }),
  z.strictObject({
    type: z.literal('credits'),
    successUrl: z.url(),
    credits: z.int().min(MIN_CREDITS),
    lang: z.string().max(10).optional(),
  }),
]);

const ResponseSchema = z.strictObject({ checkoutUrl: z.url() });

export function attachPolarCheckoutHandler(router: RouterInstance) {
  registerPath('/auth/polar/checkout', {
    post: {
      summary:
        'Create a Polar checkout session for a premium or credits purchase',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        400: {},
        401: {},
        403: {},
        409: {},
        502: {},
        503: {},
      },
    },
  });

  router.post('/polar/checkout', authenticator(true), async (ctx) => {
    const user = ctx.state.user!;

    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    // Append a checkout_id placeholder Polar fills in on redirect (unless the
    // caller already included one).
    const successUrl = body.successUrl.includes('checkout_id')
      ? body.successUrl
      : body.successUrl +
        (body.successUrl.includes('?') ? '&' : '?') +
        'checkout_id={CHECKOUT_ID}';

    // Allow the frontend to embed the checkout in an iframe (overlay).
    const embedOrigin = new URL(body.successUrl).origin;

    // Intent is carried in metadata so the webhook is authoritative and never
    // has to infer the purchase kind or amount from what was paid.
    const metadata: Record<string, string> = {
      kind: body.type,
      userId: String(user.id),
    };

    let productId: string;

    // For credits, the exact count is chosen in our modal, so we pin it with an
    // ad-hoc *fixed* price — this removes the editable amount field on the Polar
    // checkout. Premium keeps its catalog pay-what-you-want price (preset and
    // minimum of the selected product) so the user can choose to give more.
    let prices:
      | Record<
          string,
          { amountType: 'fixed'; priceAmount: number; priceCurrency: 'eur' }[]
        >
      | undefined;

    // A subscription starts as a trial as long as the premium the user already
    // has, so the periods never overlap and nobody pays for the same days
    // twice — that's what makes switching from a one-time year to a
    // subscription (before the price goes up) safe at any moment. Polar takes a
    // trial as an interval and a count, not as an absolute end date.
    let trialDays = 0;

    if (body.type === 'premium') {
      if (body.recurring) {
        // A second subscription would be invisible to the user — it starts as a
        // trial as long as the premium they already have, so nothing is charged
        // until the first one's period ends, and `subscription.created`
        // overwrites `polarSubscriptionId`, orphaning the older one. A card
        // that stopped working is fixed in the Polar customer portal, not by
        // subscribing again; `subscription.revoked` clears the ID, so a
        // genuinely finished subscription doesn't block a new one.
        // Tied to premium still being live, so a stored ID that outlived its
        // subscription (a lost `subscription.revoked`, say) can't lock anyone
        // out of buying premium for good: once the paid-for period is over,
        // the guard lets go by itself.
        const rows = await pool.query<{ subscribed: number }[]>(
          sql`SELECT 1 AS subscribed FROM user
              WHERE id = ${user.id} AND ${raw(liveSubscriptionSql())}`,
        );

        if (rows.length > 0) {
          return ctx.throw(409, 'already subscribed');
        }
      }

      try {
        productId = getPremiumProductId(body.recurring);
      } catch (err) {
        ctx.log.error({ err }, 'premium product is not configured');

        return ctx.throw(503, 'premium is not available');
      }

      if (body.recurring) {
        const premiumUntil = user.premiumExpiration?.getTime() ?? 0;

        const wantedTrialDays = Math.max(
          0,
          Math.ceil((premiumUntil - Date.now()) / 86_400_000),
        );

        // One-time years stack and admins can set `premiumExpiration` freely,
        // so this is not bounded by anything we sell. Keep it in a range Polar
        // will accept — a rejected value would fail the whole checkout.
        trialDays = Math.min(wantedTrialDays, MAX_TRIAL_DAYS);

        if (trialDays < wantedTrialDays) {
          ctx.log.warn(
            { userId: user.id, wantedTrialDays },
            'premium outlasts the longest trial; the subscription will overlap it',
          );
        }
      }

      metadata.recurring = String(body.recurring);
    } else {
      productId = getEnv('POLAR_CREDITS_PRODUCT_ID');

      // 1 credit = 1 euro cent.
      prices = {
        [productId]: [
          {
            amountType: 'fixed',
            priceAmount: body.credits,
            priceCurrency: 'eur',
          },
        ],
      };

      metadata.credits = String(body.credits);
    }

    let checkout;

    try {
      checkout = await getPolar().checkouts.create({
        products: [productId],
        externalCustomerId: String(user.id),
        // Pre-fill the checkout with what we know (email is optional in our app).
        customerEmail: user.email ?? undefined,
        customerName: user.name,
        successUrl,
        embedOrigin,
        // Hide the "add discount code" field.
        allowDiscountCodes: false,
        ...(body.lang ? { locale: body.lang } : {}),
        metadata,
        ...(prices === undefined ? {} : { prices }),
        ...(trialDays > 0
          ? { trialInterval: 'day' as const, trialIntervalCount: trialDays }
          : {}),
      });
    } catch (err) {
      ctx.log.error({ err }, 'Polar checkout creation failed');

      return ctx.throw(502, 'failed to create checkout');
    }

    ctx.body = ResponseSchema.parse({ checkoutUrl: checkout.url });
  });
}
