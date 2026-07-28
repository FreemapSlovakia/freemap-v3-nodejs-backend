import type { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { getWinbackProductId } from '../../premiumPricing.js';
import { getWinbackOffer } from '../../premiumWinback.js';
import { zNullableDateToIso } from '../../types.js';

const ResponseSchema = z.strictObject({
  eligible: z.boolean(),
  // When the user's premium access ran out; null unless eligible.
  expiredAt: zNullableDateToIso,
});

export function attachPremiumWinbackHandler(router: RouterInstance) {
  registerPath('/auth/premium/winback', {
    get: {
      summary:
        'Tell whether the user can return at the original premium price (win-back offer)',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        401: {},
      },
    },
  });

  router.get('/premium/winback', authenticator(true), async (ctx) => {
    // Report only what the checkout would actually honour: without the unlisted
    // product it sells the current price, so advertising the old one here would
    // promise €8 and charge €15.
    let offer;

    try {
      offer = getWinbackProductId()
        ? await getWinbackOffer(ctx.state.user!.id)
        : undefined;
    } catch (err) {
      // Not being able to tell just means no offer to advertise.
      ctx.log.error({ err }, 'win-back lookup failed');
    }

    ctx.body = ResponseSchema.parse({
      eligible: Boolean(offer),
      expiredAt: offer?.expiredAt ?? null,
    });
  });
}
