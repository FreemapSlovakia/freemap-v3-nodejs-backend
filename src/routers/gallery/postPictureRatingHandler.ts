import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { registerPath } from '../../openapi.js';

const BodySchema = z.strictObject({ stars: z.uint32().min(1).max(5) });

export function attachPostPictureRatingHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}/rating', {
    post: {
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'integer' } },
      ],
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        204: {},
        401: {},
        402: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.post('/pictures/:id/rating', authenticator(true), async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    await runInTransaction(async (conn) => {
      const [row] = await conn.query(
        sql`SELECT premium FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!row) {
        ctx.throw(404, 'no such picture');
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
    });

    ctx.status = 204;
  });
}
