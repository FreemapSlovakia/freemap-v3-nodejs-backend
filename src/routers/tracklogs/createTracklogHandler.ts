import { gzipSync } from 'node:zlib';
import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnvInteger } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';

// The track is whatever the client holds internally: a GeoJSON FeatureCollection.
// It is validated loosely here (the client owns the shape) and stored gzipped.
const BodySchema = z.strictObject({
  data: z.looseObject({
    type: z.literal('FeatureCollection'),
    features: z.array(z.unknown()),
  }),
});

const ResponseSchema = z.strictObject({ uid: z.string() });

const maxSizeInMB = getEnvInteger('MAX_TRACK_SIZE_IN_MB', 10);

export function attachCreateTracklogHandler(router: RouterInstance) {
  registerPath('/tracklogs', {
    post: {
      summary: 'Save a GeoJSON tracklog',
      tags: ['tracklogs'],
      security: AUTH_OPTIONAL,
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: ResponseSchema } },
        },
        400: {},
        413: { description: 'track too big' },
      },
    },
  });

  router.post(
    '/',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const json = JSON.stringify(body.data);

      if (json.length > maxSizeInMB * 1_000_000) {
        ctx.throw(413, 'track too big');
      }

      const uid = nanoid();

      await pool.query<unknown>(sql`
        INSERT INTO tracklog SET
          id = ${uid},
          userId = ${ctx.state.user?.id ?? null},
          data = ${gzipSync(json)}
      `);

      ctx.status = 201;
      ctx.body = { uid };
    },
  );
}
