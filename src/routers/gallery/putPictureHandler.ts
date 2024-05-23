import Router from '@koa/router';

import sql from 'sql-template-tag';
import { runInTransaction } from '../../database.js';
import { bodySchemaValidator } from '../../requestValidators.js';
import { authenticator } from '../../authenticator.js';

export function attachPutPictureHandler(router: Router) {
  router.put(
    '/pictures/:id',
    authenticator(true),
    bodySchemaValidator({
      type: 'object',
      required: ['position'],
      properties: {
        position: {
          type: 'object',
          required: ['lat', 'lon'],
          properties: {
            lat: {
              type: 'number',
            },
            lon: {
              type: 'number',
            },
          },
        },
        name: {
          type: ['string', 'null'],
        },
        description: {
          type: ['string', 'null'],
        },
        takenAt: {
          type: ['string', 'null'],
          format: 'date-time',
        },
        tags: {
          type: ['array', 'null'],
          items: {
            type: 'string',
          },
        },
      },
    }),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const {
        title,
        description,
        takenAt,
        position: { lat, lon },
        tags = [],
      } = ctx.request.body;

      const rows = await conn.query(
        sql`SELECT userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404, 'no such picture');
      }

      if (!ctx.state.user.isAdmin && rows[0].userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const queries = [
        conn.query(sql`
          UPDATE picture SET
            title = ${title},
            description = ${description},
            takenAt = ${takenAt ? new Date(takenAt) : null},
            lat = ${lat},
            lon = ${lon}
            WHERE id = ${ctx.params.id}
        `),

        // delete missing tags
        conn.query(
          `DELETE FROM pictureTag WHERE pictureId = ?
            ${
              tags.length
                ? ` AND name NOT IN (${tags.map(() => '?').join(', ')})`
                : ''
            }`,
          [ctx.params.id, ...tags],
        ),
      ];

      if (tags.length) {
        queries.push(
          conn.query(
            `INSERT INTO pictureTag (name, pictureId)
              VALUES ${tags.map(() => '(?, ?)').join(', ')}
              ON DUPLICATE KEY UPDATE name = name`,
            [].concat(...tags.map((tag: string) => [tag, ctx.params.id])),
          ),
        );
      }

      await Promise.all(queries);

      ctx.status = 204;
    },
  );
}
