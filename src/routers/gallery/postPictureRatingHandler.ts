import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { parsePictureId } from './pictureId.js';

const BodySchema = z.strictObject({ stars: z.uint32().min(1).max(5) });

export function attachPostPictureRatingHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}/rating', {
    post: {
      summary: 'Rate a gallery picture',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      requestBody: {
        content: {
          'application/json': {
            schema: BodySchema,
          },
        },
      },
      responses: {
        204: {},
        401: {},
        402: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.post('/pictures/:id/rating', authenticator(true), async (ctx) => {
    const ref = parsePictureId(ctx.params.id);

    if (!ref) {
      return ctx.throw(404, 'no such picture');
    }

    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    if (ref.source === 'wikimedia') {
      const { stars } = body;
      const user = ctx.state.user!;

      await runInTransaction(async (conn) => {
        const [row] = await conn.query<{ pageId: number }[]>(
          sql`SELECT pageId FROM wikimediaPicture WHERE pageId = ${ref.pageId}`,
        );

        if (!row) {
          ctx.throw(404, 'no such picture');
        }

        await conn.query<unknown>(sql`
          INSERT INTO wikimediaRating SET
              pageId = ${ref.pageId},
              userId = ${user.id},
              stars = ${stars},
              ratedAt = ${new Date()}
            ON DUPLICATE KEY UPDATE stars = ${stars}, ratedAt = ${new Date()}
        `);
      });

      ctx.status = 204;

      return;
    }

    await runInTransaction(async (conn) => {
      const [row] = await conn.query<{ userId: number; premium: boolean }[]>(
        sql`SELECT userId, premium FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
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

      await conn.query<unknown>(sql`
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
