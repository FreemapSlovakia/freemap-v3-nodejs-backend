import type { RouterInstance } from '@koa/router';
import z from 'zod';
import { AppTokenScopeSchema } from '../../appTokens.js';
import { authenticator } from '../../authenticator.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';

const QuerySchema = z.object({
  scope: AppTokenScopeSchema.optional(),
  premium: z
    .literal('1')
    .optional()
    .meta({ description: 'Refuse with 403 unless the account has premium' }),
});

const ResponseSchema = z
  .strictObject({
    userId: z.uint32(),
    premium: z.boolean(),
  })
  .meta({ id: 'AuthCheck' });

export function attachCheckHandler(router: RouterInstance) {
  registerPath('/auth/check', {
    get: {
      summary:
        'Authorize a request for another Freemap service (e.g. as an nginx auth_request)',
      description:
        'Accepts a session or an app token. With `scope`, an app token must hold it; a session holds every scope. The answer is also sent as `X-User-Id` and `X-Premium` headers.',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: { query: QuerySchema },
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseSchema } },
        },
        400: {},
        401: {},
        403: {
          description: 'the app token lacks the scope, or premium is required',
        },
      },
    },
  });

  router.get('/check', authenticator(true, 'any'), async (ctx) => {
    let query;

    try {
      query = QuerySchema.parse(ctx.query);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const user = ctx.state.user!;

    if (
      query.scope &&
      user.appToken &&
      !user.appToken.scopes.includes(query.scope)
    ) {
      ctx.set(
        'WWW-Authenticate',
        `Bearer realm="freemap"; error="insufficient_scope"; scope="${query.scope}"`,
      );

      ctx.throw(403, `app token lacks scope ${query.scope}`);
    }

    const premium =
      user.premiumExpiration !== null && user.premiumExpiration > new Date();

    if (query.premium && !premium) {
      ctx.throw(403, 'premium required');
    }

    ctx.set('X-User-Id', String(user.id));

    ctx.set('X-Premium', premium ? '1' : '0');

    ctx.body = ResponseSchema.parse({ userId: user.id, premium });
  });
}
