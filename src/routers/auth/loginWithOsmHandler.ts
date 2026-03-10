import { RouterInstance } from '@koa/router';
import got from 'got';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const clientId = getEnv('OSM_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('OSM_OAUTH2_CLIENT_SECRET');

const BodySchema = z.strictObject({
  code: z.string(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
  redirectUri: z.string(),
});

const OsmTokenSchema = z.object({ access_token: z.string() });

const OsmUserDetailsSchema = z.object({
  user: z.object({
    id: z.uint32(),
    display_name: z.string(),
    home: z.object({ lat: z.number(), lon: z.number() }).optional(),
  }),
});

export function attachLoginWithOsmHandler(router: RouterInstance) {
  registerPath('/auth/login-osm', {
    get: {
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
          redirectUri + (connect === undefined ? '' : '?connect=' + connect),
      });

      const body = OsmTokenSchema.parse(
        await got
          .post('https://www.openstreetmap.org/oauth2/token?' + sp.toString(), {
            headers: {
              'content-type': 'application/x-www-form-urlencoded', // otherwise server returns 415
            },
          })
          .json(),
      );

      const userDetails = OsmUserDetailsSchema.parse(
        await got
          .get('https://api.openstreetmap.org/api/0.6/user/details', {
            headers: {
              authorization: 'Bearer ' + body.access_token,
            },
          })
          .json(),
      );

      const {
        user: { display_name: osmName, id: osmId, home },
      } = userDetails;

      const { lat, lon } = home ?? {};

      await login(
        ctx,
        'osm',
        Number(osmId),
        osmName,
        null,
        lat === undefined ? undefined : Number(lat),
        lon === undefined ? undefined : Number(lon),
        language,
        connect,
      );
    },
  );
}
