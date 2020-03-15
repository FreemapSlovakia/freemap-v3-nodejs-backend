const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { bodySchemaValidator } = require('~/requestValidators');
const postPictureRatingSchema = require('./postPictureRatingSchema');
const authenticator = require('~/authenticator');

module.exports = function attachPostPictureRatingHandler(router) {
  router.post(
    '/pictures/:id/rating',
    authenticator(true),
    bodySchemaValidator(postPictureRatingSchema, true),
    async ctx => {
      const { stars } = ctx.request.body;

      await pool.query(SQL`
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
};
