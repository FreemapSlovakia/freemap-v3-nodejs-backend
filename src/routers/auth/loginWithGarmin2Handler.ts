import { RouterInstance } from '@koa/router';
import got from 'got';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { garminOauth } from '../../garminOauth.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LoginResponseSchema } from '../../types.js';
import { tokenSecrets } from './garminTokenSecrets.js';
import { login } from './loginProcessor.js';

const BodySchema = z.strictObject({
  token: z.string(),
  verifier: z.string(),
  language: z.string().nullable(),
});

const GarminUserSchema = z.object({ userId: z.string() });

export function attachLoginWithGarmin2Handler(router: RouterInstance) {
  registerPath('/auth/login-garmin-2', {
    post: {
      summary: 'Complete Garmin OAuth login (step 2 — exchange token)',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: {
          content: { 'application/json': { schema: LoginResponseSchema } },
        },
        400: {},
        403: { description: 'session not found' },
      },
    },
  });

  router.post(
    '/login-garmin-2',
    authenticator(false),
    acceptValidator('application/json'),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { token, verifier, language } = body;

      const url =
        'https://connectapi.garmin.com/oauth-service/oauth/access_token';

      const session = tokenSecrets.get(token);

      if (!session) {
        return ctx.throw(403, 'session not found');
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...garminOauth.toHeader(
            garminOauth.authorize(
              {
                url,
                method: 'POST',
                data: { oauth_verifier: verifier },
              },
              {
                key: token,
                secret: session.tokenSecret,
              },
            ),
          ),
        },
      });

      if (!response.ok) {
        throw new Error('Authorization error:' + (await response.text()));
      }

      const sp = new URLSearchParams(await response.text());

      const authToken = sp.get('oauth_token');

      if (!authToken) {
        return ctx.throw(400, 'missing oauth_token');
      }

      const authTokenSecret = sp.get('oauth_token_secret');

      if (!authTokenSecret) {
        return ctx.throw(400, 'missing oauth_token_secret');
      }

      const url2 = 'https://apis.garmin.com/wellness-api/rest/user/id';

      const body2 = GarminUserSchema.parse(
        await got
          .get(url2, {
            headers: {
              ...garminOauth.toHeader(
                garminOauth.authorize(
                  {
                    url: url2,
                    method: 'GET',
                  },
                  {
                    key: authToken,
                    secret: authTokenSecret,
                  },
                ),
              ),
            },
          })
          .json(),
      );

      await login(
        ctx,
        'garmin',
        body2.userId,
        body2.userId,
        null,
        undefined,
        undefined,
        language,
        session.connect,
        {
          garminAccessToken: authToken,
          garminAccessTokenSecret: authTokenSecret,
        },
        session.clientData,
      );
    },
  );
}
