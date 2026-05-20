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
  picture: z
    .object({
      data: z.object({
        url: z.url().optional(),
        is_silhouette: z.boolean().optional(),
      }),
    })
    .nullish(),
});

async function getUserData(accessToken: string) {
  return FacebookUserSchema.parse(
    await got(
      'https://graph.facebook.com/v20.0/me?fields=id,name,email,picture.width(256).height(256)&access_token=' +
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

    const { id, name, email, picture } = await getUserData(accessToken);

    const pictureUrl = picture?.data.is_silhouette
      ? null
      : (picture?.data.url ?? null);

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
      undefined,
      undefined,
      pictureUrl,
    );
  });
}
