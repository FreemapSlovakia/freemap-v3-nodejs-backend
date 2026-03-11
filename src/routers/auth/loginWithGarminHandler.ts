import { RouterInstance } from '@koa/router';
import z from 'zod';
import { garminOauth } from '../../garminOauth.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { tokenSecrets } from './garminTokenSecrets.js';

const BodySchema = z.strictObject({
  connect: z.unknown(),
  clientData: z.unknown(),
  callbackUrl: z.url(),
  extraQuery: z.record(z.string(), z.unknown()).optional(),
});

const ResponseSchema = z.strictObject({ redirectUrl: z.string() });

export function attachLoginWithGarminHandler(router: RouterInstance) {
  registerPath('/auth/login-garmin', {
    post: {
      summary: 'Initiate Garmin OAuth login (step 1 — get redirect URL)',
      tags: ['auth'],
      requestBody: {
        content: {
          'application/json': {
            schema: BodySchema,
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: ResponseSchema,
            },
          },
        },
        400: {},
      },
    },
  });

  router.post(
    '/login-garmin',
    acceptValidator('application/json'),
    async (ctx) => {
      const url =
        'https://connectapi.garmin.com/oauth-service/oauth/request_token';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...garminOauth.toHeader(
            garminOauth.authorize({
              url,
              method: 'POST',
            }),
          ),
        },
      });

      if (!response.ok) {
        throw new Error('Authorization error: ' + (await response.text()));
      }

      const sp = new URLSearchParams(await response.text());

      const token = sp.get('oauth_token');

      if (!token) {
        return ctx.throw(400, 'missing oauth_token');
      }

      const tokenSecret = sp.get('oauth_token_secret');

      if (!tokenSecret) {
        return ctx.throw(400, 'missing oauth_token_secret');
      }

      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      tokenSecrets.set(token, {
        tokenSecret,
        connect: Boolean(body.connect),
        clientData: body.clientData,
      });

      setTimeout(() => tokenSecrets.delete(token), 30 * 60_000); // max 30 minutes

      const callback = new URL(body.callbackUrl);

      // extraQuery is unused now
      for (const [key, value] of Object.entries(body.extraQuery ?? {})) {
        callback.searchParams.set(key, String(value));
      }

      ctx.body = ResponseSchema.parse({
        redirectUrl:
          'https://connect.garmin.com/oauthConfirm?oauth_callback=' +
          encodeURIComponent(callback.toString()) +
          '&oauth_token=' +
          encodeURIComponent(token),
      });
    },
  );
}
