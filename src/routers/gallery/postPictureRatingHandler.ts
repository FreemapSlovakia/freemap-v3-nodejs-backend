import Router from '@koa/router';
import sql from 'sql-template-tag';
import { pool } from '../../database';
import { bodySchemaValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

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
    async (ctx) => {
      const { stars } = ctx.request.body;

      await pool.query(sql`
        INSERT INTO pictureRating SET
            pictureId = ${ctx.params.id},
            userId = ${ctx.state.user.id},
            stars = ${stars},
            ratedAt = ${new Date()}
          ON DUPLICATE KEY UPDATE stars = ${stars}, ratedAt = ${new Date()}
      `);

      ctx.status = 204;
    },
  );
}
