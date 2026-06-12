import { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { getEnv } from '../../env.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { getPolar, isPolarEnabled } from '../../polar.js';

// 1 credit = €0.01, so the chosen credit count equals the amount in euro cents.
const MIN_CREDITS = 500;

const BodySchema = z.union([
  z.strictObject({
    type: z.literal('premium'),
    successUrl: z.url(),
    // true = auto-renewing yearly subscription; false = one-time year.
    recurring: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('credits'),
    successUrl: z.url(),
    credits: z.int().min(MIN_CREDITS),
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
      },
    },
  });

  router.post('/polar/checkout', authenticator(true), async (ctx) => {
    const user = ctx.state.user!;

    if (!isPolarEnabled(user.id)) {
      return ctx.throw(403, 'Polar payments are not enabled for this account');
    }

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

    // Intent is carried in metadata so the webhook is authoritative and never
    // has to infer the purchase kind or amount from what was paid.
    const metadata: Record<string, string> = {
      kind: body.type,
      userId: String(user.id),
    };

    let productId: string;
    // Amount override in euro cents. Only set for credits, where the count is
    // chosen in our modal. Premium is left as pay-what-you-want so Polar's
    // checkout collects the amount (preset/min €8) and the user can give more.
    let amount: number | undefined;

    if (body.type === 'premium') {
      productId = body.recurring
        ? getEnv('POLAR_PREMIUM_RECURRING_PRODUCT_ID')
        : getEnv('POLAR_PREMIUM_ONETIME_PRODUCT_ID');

      metadata.recurring = String(body.recurring);
    } else {
      productId = getEnv('POLAR_CREDITS_PRODUCT_ID');

      // 1 credit = 1 euro cent.
      amount = body.credits;

      metadata.credits = String(body.credits);
    }

    let checkout;

    try {
      checkout = await getPolar().checkouts.create({
        products: [productId],
        externalCustomerId: String(user.id),
        customerEmail: user.email ?? undefined,
        successUrl,
        // Allow the frontend to embed the checkout in an iframe (overlay).
        embedOrigin: new URL(body.successUrl).origin,
        metadata,
        ...(amount === undefined ? {} : { amount }),
      });
    } catch (err) {
      ctx.log.error({ err }, 'Polar checkout creation failed');

      return ctx.throw(502, 'failed to create checkout');
    }

    ctx.body = ResponseSchema.parse({ checkoutUrl: checkout.url });
  });
}
