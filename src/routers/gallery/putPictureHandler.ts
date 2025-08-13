import Router from '@koa/router';
import sql, { bulk } from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';

export function attachPutPictureHandler(router: Router) {
  router.put(
    '/pictures/:id',
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      type Body = {
        position: {
          lat: number;
          lon: number;
        };
        azimuth?: number | null;
        title?: string | null;
        description?: string | null;
        takenAt?: (string & tags.Format<'date-time'>) | null;
        tags?: string[] | null;
        premium?: boolean;
      };

      const conn = ctx.state.dbConn!;

      let body;

      try {
        body = assert<Body>(ctx.request.body);
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
            lat = ${lat},
            lon = ${lon},
            azimuth = ${azimuth},
            premium = ${premium}
            WHERE id = ${ctx.params.id}
        `),

        // delete missing tags
        conn.query(
          `DELETE FROM pictureTag WHERE pictureId = ?
            ${
              tags?.length
                ? ` AND name NOT IN (${tags.map(() => '?').join(', ')})`
                : ''
            }`,
          [ctx.params.id, ...(tags ?? [])],
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

      ctx.status = 204;
    },
  );
}
