const config = require('config');
const { dbMiddleware } = require('~/database');
const { acceptValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureCommentSchema = require('./postPictureCommentSchema');
const authenticator = require('~/authenticator');

const webBaseUrl = config.get('webBaseUrl');
const mailgunConfig = config.get('mailgun');

const mailgun = !mailgunConfig ? null : require('mailgun-js')(mailgunConfig);

module.exports = function attachPostPictureCommentHandler(router) {
  router.post(
    '/pictures/:id/comments',
    dbMiddleware,
    authenticator(true),
    bodySchemaValidator(postPictureCommentSchema, true),
    acceptValidator('application/json'),
    async (ctx) => {
      const { comment } = ctx.request.body;

      const [{ insertId }, [{ email, title, userId }]] = await Promise.all([
        ctx.state.db.query(
          'INSERT INTO pictureComment (pictureId, userId, comment, createdAt) VALUES (?, ?, ?, ?)',
          [ctx.params.id, ctx.state.user.id, comment, new Date()],
        ),
        ctx.state.db.query(
          'SELECT email, title, userId FROM user JOIN picture ON picture.userId = user.id WHERE picture.id = ?',
          [ctx.params.id],
        ),
      ]);

      if (mailgun && email && userId !== ctx.state.user.id) {
        await mailgun.messages().send({
          from: 'Freemap Fotky <noreply@freemap.sk>',
          to: email,
          subject: `Komentár k fotke na ${webBaseUrl.replace(/^https?:\/\//, '')}`,
          text: `Používateľ ${ctx.state.user.name} pridal komentár k fotke ${title ? `"${title} "` : ''}na ${webBaseUrl}/?image=${ctx.params.id}:\n\n${comment}`,
        });
      }

      ctx.body = { id: insertId };
    },
  );
};
