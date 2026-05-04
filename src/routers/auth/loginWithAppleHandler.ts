import { RouterInstance } from '@koa/router';
import appleSignin from 'apple-signin-auth';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
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
        appleIdPayload = await appleSignin.verifyIdToken(identityToken, {
          // You can pass the client_id here to be strictly validated,
          // but if we accept tokens from multiple bundles (e.g. mobile app bundle ID, and maybe a web service ID),
          // it's sometimes better to let the library just verify the signature if not explicitly set,
          // or specify multiple options. We will leave it to verify the signature using Apple's keys.
          ignoreExpiration: false,
        });
      } catch (err) {
        ctx.log.warn({ err }, 'Invalid Apple identityToken.');

        return ctx.throw(400, 'Invalid Apple identityToken.');
      }

      const { sub, email } = appleIdPayload;

      await login(
        ctx,
        'apple',
        sub,
        name,
        email,
        undefined,
        undefined,
        language,
        connect,
      );
    },
  );
}
