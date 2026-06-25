import { gunzipSync } from 'node:zlib';
import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const uidSchema = z
  .string()
  .regex(/^[a-zA-Z0-9]+$/)
  .max(32);

const ResponseSchema = z.strictObject({
  uid: uidSchema,
  data: z.looseObject({
    type: z.literal('FeatureCollection'),
    features: z.array(z.unknown()),
  }),
});

const DbRowSchema = z.object({ data: z.instanceof(Buffer) });

export function attachGetTracklogHandler(router: RouterInstance) {
  registerPath('/tracklogs/{uid}', {
    get: {
      summary: 'Retrieve a GeoJSON tracklog by UID',
      tags: ['tracklogs'],
      requestParams: {
        path: z.object({
          uid: uidSchema,
        }),
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
        404: { description: 'tracklog not found' },
      },
    },
  });

  router.get('/:uid', acceptValidator('application/json'), async (ctx) => {
    const parsed = uidSchema.safeParse(ctx.params.uid);

    if (!parsed.success) {
      ctx.throw(400, 'invalid id format');
    }

    const uid = parsed.data;

    const [row] = DbRowSchema.array()
      .max(1)
      .parse(
        await pool.query<unknown>(
          sql`SELECT data FROM tracklog WHERE id = ${uid}`,
        ),
      );

    if (!row) {
      ctx.throw(404, 'tracklog not found');
    }

    await pool.query<unknown>(
      sql`UPDATE tracklog SET lastReadAt = NOW() WHERE id = ${uid}`,
    );

    ctx.body = ResponseSchema.parse({
      uid,
      data: JSON.parse(gunzipSync(row.data).toString('utf8')),
    });
  });
}
