import { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const BodySchema = z.strictObject({
  accessToken: z.string().nonempty(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
});

const GoogleUserSchema = z.object({
  sub: z.string(),
  name: z.string().optional(),
  email: z.email().optional(),
});

export function attachLoginWithGoogleHandler(router: RouterInstance) {
  registerPath('/auth/login-google', {
    post: {
      summary: 'Log in with Google OAuth',
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
    '/login-google',
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

      const { accessToken, language, connect } = body;

      const userinfoRes = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!userinfoRes.ok) {
        throw new Error('Failed to fetch user info from Google');
      }

      const { sub, name, email } = GoogleUserSchema.parse(
        await userinfoRes.json(),
      );

      await login(
        ctx,
        'google',
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
