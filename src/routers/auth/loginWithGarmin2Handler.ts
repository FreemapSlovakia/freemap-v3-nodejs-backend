import type { RouterInstance } from '@koa/router';
import got, { HTTPError } from 'got';
import type { ParameterizedContext } from 'koa';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { garminOauth } from '../../garminOauth.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LoginResponseSchema } from '../../types.js';
import { tokenSecrets } from './garminTokenSecrets.js';
import { login } from './loginProcessor.js';

const BodySchema = z.strictObject({
  token: z.string().nonempty(),
  verifier: z.string().nonempty(),
  language: z.string().nonempty().nullable(),
});

const GarminUserSchema = z.object({ userId: z.string() });

// Map a non-2xx Garmin response to the right outcome. A 4xx means the OAuth
// session is invalid/expired or the user lacks a required permission — a client
// problem, so surface it as a 4xx (filtered out of Sentry in instrument.ts). A
// 5xx is a Garmin-side outage; rethrow it as a 500 so it stays visible in
// Sentry rather than being masked as a client error.
function throwGarminError(
  ctx: ParameterizedContext,
  status: number,
  detail: string,
): never {
  if (status >= 400 && status < 500) {
    ctx.log.warn({ status, detail }, 'garmin request rejected');

    ctx.throw(status === 403 ? 403 : 401, 'Garmin authorization failed');
  }

  throw new Error(`garmin request failed (${status}): ${detail}`);
}

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
        throwGarminError(ctx, response.status, await response.text());
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

      let userResponse;

      try {
        userResponse = await got
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
          .json();
      } catch (err) {
        // A Garmin 4xx here (401 revoked/expired token, 403 missing permission)
        // is a client problem; let throwGarminError surface it as a 4xx. Any
        // other error (5xx, parse, network) bubbles up as a 500 so genuine
        // failures stay visible in Sentry.
        if (err instanceof HTTPError) {
          throwGarminError(
            ctx,
            err.response.statusCode,
            String(err.response.body),
          );
        }

        throw err;
      }

      const body2 = GarminUserSchema.parse(userResponse);

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
