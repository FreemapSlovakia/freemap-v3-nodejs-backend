import Router from '@koa/router';
import { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';

export function attachPostPictureRatingHandler(router: Router) {
  router.post(
    '/pictures/:id/rating',
    authenticator(true),
    runInTransaction(),

    async (ctx) => {
      type Body = {
        stars: number & tags.Type<'uint32'> & tags.Minimum<1> & tags.Maximum<5>;
      };

      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const conn = ctx.state.dbConn as PoolConnection;

      const [row] = await conn.query(
        sql`SELECT premium FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!row) {
        ctx.throw(404);
      }

      const user = ctx.state.user!;

      if (
        row.premium &&
        (!user.premiumExpiration || user.premiumExpiration < new Date()) &&
        user.id !== row.userId
      ) {
        ctx.throw(402);
      }

      const { stars } = body;

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
