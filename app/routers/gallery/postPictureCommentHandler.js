const { dbMiddleware } = require('~/database');
const { acceptValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureCommentSchema = require('./postPictureCommentSchema');
const authenticator = require('~/authenticator');

module.exports = function attachPostPictureCommentHandler(router) {
  router.post(
    '/picture/:id/comment',
    dbMiddleware,
    authenticator(true),
    bodySchemaValidator(postPictureCommentSchema, true),
    acceptValidator('application/json'),
    async (ctx) => {
      const { comment } = ctx.request.body;

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO pictureComment (pictueId, userId, comment, createdAt) VALUES (?, ?, ?)',
        [ctx.params.id, ctx.state.user.id, comment, new Date()],
      );

      ctx.body = { id: insertId };
    },
  );
};
