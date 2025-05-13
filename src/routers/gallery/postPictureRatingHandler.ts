import Router from '@koa/router';
import { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { bodySchemaValidator } from '../../requestValidators.js';

export function attachPostPictureRatingHandler(router: Router) {
  router.post(
    '/pictures/:id/rating',
    authenticator(true),
    bodySchemaValidator(
      {
        type: 'object',
        required: ['stars'],
        properties: {
          stars: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
          },
        },
      },
      true,
    ),
    runInTransaction(),

    async (ctx) => {
      const conn = ctx.state.dbConn as PoolConnection;

      const [row] = await conn.query(
        sql`SELECT premium FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!row) {
        ctx.throw(404);
      }

      const user = ctx.state.user!;

      if (row.premium && !user.isPremium && user.id !== row.userId) {
        ctx.throw(402);
      }

      const { stars } = ctx.request.body;

      await conn.query(sql`
        INSERT INTO pictureRating SET
            pictureId = ${ctx.params.id},
            userId = ${user.id},
            stars = ${stars},
            ratedAt = ${new Date()}
          ON DUPLICATE KEY UPDATE stars = ${stars}, ratedAt = ${new Date()}
      `);

      ctx.status = 204;
    },
  );
}
