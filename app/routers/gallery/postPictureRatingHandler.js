const { dbMiddleware } = require('~/database');
const { bodySchemaValidator } = require('~/requestValidators');
const postPictureRatingSchema = require('./postPictureRatingSchema');
const authenticator = require('~/authenticator');

module.exports = function attachPostPictureRatingHandler(router) {
  router.post(
    '/pictures/:id/rating',
    dbMiddleware(),
    authenticator(true),
    bodySchemaValidator(postPictureRatingSchema, true),
    async ctx => {
      const { stars } = ctx.request.body;

      await ctx.state.db.query(
        `INSERT INTO pictureRating (pictureId, userId, stars, ratedAt)
          VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE stars = ?, ratedAt = ?`,
        [
          ctx.params.id,
          ctx.state.user.id,
          stars,
          new Date(),
          stars,
          new Date(),
        ],
      );

      ctx.status = 204;
    },
  );
};
