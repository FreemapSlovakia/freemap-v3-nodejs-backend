import type { RouterInstance } from '@koa/router';
import appleSignin from 'apple-signin-auth';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { checkTokenAudience } from '../../tokenAudience.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const BodySchema = z.strictObject({
  identityToken: z.string().nonempty(),
  name: z.string().nullish(),
  language: z.string().nullish(),
  connect: z.boolean().nullish(),
});

export function attachLoginWithAppleHandler(router: RouterInstance) {
  registerPath('/auth/login-apple', {
    post: {
      summary: 'Log in with Apple OAuth',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: {
          content: { 'application/json': { schema: LoginResponseSchema } },
        },
        400: {},
        409: {
          description: 'A different remote account than the connected one',
        },
      },
    },
  });

  router.post(
    '/login-apple',
    authenticator(false),
    acceptValidator('application/json'),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        ctx.log.warn({ body }, 'Invalid body.');

        return ctx.throw(400, err as Error);
      }

      const { identityToken, name, language, connect } = body;

      let appleIdPayload;
      try {
        // The audience is checked below, to log one this doesn't know.
        appleIdPayload = await appleSignin.verifyIdToken(identityToken, {
          ignoreExpiration: false,
        });
      } catch (err) {
        ctx.log.warn({ err }, 'Invalid Apple identityToken.');

        return ctx.throw(400, 'Invalid Apple identityToken.');
      }

      // Another app's token (let through while not enforced) proves no address.
      const ours = checkTokenAudience(ctx, 'apple', [appleIdPayload.aud]);

      const { sub, email, email_verified } = appleIdPayload;

      await login(
        ctx,
        'apple',
        sub,
        name ?? undefined,
        email,
        undefined,
        undefined,
        language ?? null,
        connect ?? undefined,
        {
          remoteEmailVerified:
            ours && (email_verified === true || email_verified === 'true'),
        },
      );
    },
  );
}
