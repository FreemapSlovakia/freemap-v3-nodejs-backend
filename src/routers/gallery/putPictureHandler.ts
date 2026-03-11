import { RouterInstance } from '@koa/router';
import sql, { bulk, empty, join } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';

const BodySchema = z.strictObject({
  position: z.strictObject({
    lat: z.number(),
    lon: z.number(),
  }),
  azimuth: z.number().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  takenAt: z.iso.datetime().nullish(),
  tags: z.array(z.string()).nullish(),
  premium: z.boolean().optional(),
});

export function attachPutPictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}', {
    put: {
      summary: 'Update gallery picture metadata',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'integer' },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: BodySchema,
          },
        },
      },
      responses: {
        204: {},
        400: {},
        401: {},
        403: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.put('/pictures/:id', authenticator(true), async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const {
      title,
      description,
      takenAt,
      position: { lat, lon },
      tags = [],
      azimuth,
      premium,
    } = body;

    await runInTransaction(async (conn) => {
      const rows = await conn.query(
        sql`SELECT userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404, 'no such picture');
      }

      if (!ctx.state.user!.isAdmin && rows[0].userId !== ctx.state.user!.id) {
        ctx.throw(403);
      }

      const queries = [
        conn.query(sql`
          UPDATE picture SET
            title = ${title},
            description = ${description},
            takenAt = ${takenAt ? new Date(takenAt) : null},
            location = POINT(${lon}, ${lat}),
            azimuth = ${azimuth},
            premium = ${premium}
            WHERE id = ${ctx.params.id}
        `),

        // delete missing tags
        conn.query(
          sql`DELETE FROM pictureTag WHERE pictureId = ${ctx.params.id}
            ${tags?.length ? ` AND name NOT IN (${join(tags)})` : empty}`,
        ),
      ];

      if (tags?.length) {
        queries.push(
          conn.query(
            sql`INSERT INTO pictureTag (name, pictureId)
                  VALUES ${bulk(tags.map((tag: string) => [tag, ctx.params.id]))}
                  ON DUPLICATE KEY UPDATE name = name`,
          ),
        );
      }

      await Promise.all(queries);
    });

    ctx.status = 204;
  });
}
