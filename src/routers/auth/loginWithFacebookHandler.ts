import type { RouterInstance } from '@koa/router';
import got, { HTTPError, RequestError } from 'got';
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
      'https://graph.facebook.com/v20.0/me?fields=id,name,email,picture.width(256).height(256)',
      {
        // In a header, not the query string: got puts the URL into its
        // HTTPError message, which put the user's whole token into Sentry.
        headers: { authorization: `Bearer ${accessToken}` },
      },
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
        401: { description: 'Facebook refused the token' },
        409: {
          description: 'A different remote account than the connected one',
        },
        502: { description: 'Facebook failed or is unreachable' },
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

    let user;

    try {
      user = await getUserData(accessToken);
    } catch (err) {
      // 4xx: Facebook refuses the token — expired, revoked, or the iOS app's
      // Limited Login JWT, which Graph does not take. Anything else is
      // Facebook failing or unreachable. Either way not our 500.
      if (err instanceof HTTPError) {
        const { statusCode } = err.response;

        return statusCode >= 400 && statusCode < 500
          ? ctx.throw(401, 'invalid Facebook token')
          : ctx.throw(502, 'Facebook unavailable');
      }

      if (err instanceof RequestError) {
        return ctx.throw(502, 'Facebook unavailable');
      }

      throw err;
    }

    const { id, name, email, picture } = user;

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
      { remotePictureUrl: pictureUrl },
    );
  });
}
