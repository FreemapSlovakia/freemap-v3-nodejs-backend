import { RouterInstance } from '@koa/router';
import got from 'got';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const FacebookUserSchema = z.object({
  id: z.string().nonempty(),
  name: z.string(),
  email: z.email().nullish(),
});

async function getUserData(accessToken: string) {
  return FacebookUserSchema.parse(
    await got(
      'https://graph.facebook.com/v20.0/me?fields=id,name,email&access_token=' +
        encodeURIComponent(accessToken),
    ).json(),
  );
}

const BodySchema = z.strictObject({
  accessToken: z.string().nonempty(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
});

export function attachLoginWithFacebookHandler(router: RouterInstance) {
  registerPath('/auth/login-fb', {
    post: {
      summary: 'Log in with Facebook OAuth',
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
  router.post('/login-fb', authenticator(false), async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const { accessToken, language, connect } = body;

    const { id, name, email } = await getUserData(accessToken);

    await login(
      ctx,
      'facebook',
      id,
      name,
      email ?? null,
      undefined,
      undefined,
      language,
      connect,
    );
  });
}
