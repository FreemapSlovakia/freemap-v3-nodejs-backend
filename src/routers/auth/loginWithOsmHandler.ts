import type { RouterInstance } from '@koa/router';
import got from 'got';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import {
  OSM_CLIENT_ID as clientId,
  OSM_CLIENT_SECRET as clientSecret,
  fetchOsmUser,
  OSM_USER_AGENT,
  revokeOsmTokenIfUnheld,
  revokeOsmTokenLater,
} from '../../osm.js';
import { acceptValidator } from '../../requestValidators.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const BodySchema = z.strictObject({
  code: z.string().nonempty(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
  redirectUri: z.url(),
});

const OsmTokenSchema = z.object({
  access_token: z.string(),
  scope: z.string().optional(),
});

export function attachLoginWithOsmHandler(router: RouterInstance) {
  registerPath('/auth/login-osm', {
    get: {
      summary: 'Get OSM OAuth client ID to initiate login',
      tags: ['auth'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.strictObject({ clientId: z.string() }),
            },
          },
        },
      },
    },
    post: {
      summary: 'Complete OSM OAuth login',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
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
              schema: LoginResponseSchema,
            },
          },
        },
        400: {},
        409: { description: 'A different OSM account than the connected one' },
      },
    },
  });

  router.get('/login-osm', (ctx) => {
    ctx.body = { clientId };
  });

  router.post(
    '/login-osm',
    authenticator(false),
    acceptValidator('application/json'),
    async (ctx) => {
      let bdy;

      try {
        bdy = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { code, language, connect, redirectUri } = bdy;

      const sp = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          redirectUri + (connect === undefined ? '' : `?connect=${connect}`),
      });

      const body = OsmTokenSchema.parse(
        await got
          .post(`https://www.openstreetmap.org/oauth2/token?${sp.toString()}`, {
            headers: {
              'content-type': 'application/x-www-form-urlencoded', // otherwise server returns 415
              'user-agent': OSM_USER_AGENT,
            },
          })
          .json(),
      );

      // Without it a write_gpx grant can't be told from a plain login, and the
      // upload would ask to authorize again and again.
      if (body.scope === undefined) {
        ctx.log.warn('OSM token response has no scope.');
      }

      // A plain login asks for read_prefs only; that token is of no use later
      // and is revoked below.
      const storesToken = Boolean(body.scope?.split(' ').includes('write_gpx'));

      let stored = false;

      try {
        const {
          display_name: osmName,
          id: osmId,
          home,
          img,
        } = await fetchOsmUser(body.access_token);

        await login(
          ctx,
          'osm',
          osmId,
          osmName,
          null,
          home?.lat,
          home?.lon,
          language,
          connect,
          storesToken ? { osmAccessToken: body.access_token } : undefined,
          undefined,
          img?.href ?? null,
          storesToken
            ? (previousRows) => {
                stored = true;

                // The tokens the new one replaced on the rows the login wrote;
                // no other row can hold them.
                for (const { osmAccessToken } of previousRows) {
                  if (osmAccessToken && osmAccessToken !== body.access_token) {
                    revokeOsmTokenLater(osmAccessToken, ctx.log);
                  }
                }
              }
            : undefined,
        );
      } finally {
        // Nothing would revoke these later. A plain login's token is never
        // stored; one the login failed to store (e.g. another OSM account than
        // the connected one) may be after all. Without a scope it may be a real
        // grant, so it is left alone.
        if (!storesToken && body.scope !== undefined) {
          revokeOsmTokenLater(body.access_token, ctx.log);
        } else if (storesToken && !stored) {
          revokeOsmTokenIfUnheld(body.access_token, ctx.log);
        }
      }
    },
  );
}
