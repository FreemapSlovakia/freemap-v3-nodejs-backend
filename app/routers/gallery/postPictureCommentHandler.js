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

      const proms = [ctx.state.db.query(
        'INSERT INTO pictureComment (pictureId, userId, comment, createdAt) VALUES (?, ?, ?, ?)',
        [ctx.params.id, ctx.state.user.id, comment, new Date()],
      )];

      if (mailgun) {
        proms.push(
          ctx.state.db.query(
            'SELECT email, title, userId FROM user JOIN picture ON userId = user.id WHERE picture.id = ?',
            [ctx.params.id],
          ),
          ctx.state.db.query(
            'SELECT DISTINCT email FROM user JOIN pictureComment ON userId = user.id WHERE pictureId = ? AND userId <> ? AND email IS NOT NULL',
            [ctx.params.id, ctx.state.user.id],
          ),
        );
      }

      const [{ insertId }, picInfo, emails] = await Promise.all(proms);

      if (picInfo && emails) {
        const [{ email, title, userId }] = picInfo;

        const sendMail = (to, own) => mailgun.messages().send({
          from: 'Freemap Fotky <noreply@freemap.sk>',
          to,
          subject: `Komentár k fotke na ${webBaseUrl.replace(/^https?:\/\//, '')}`,
          text: `Používateľ ${ctx.state.user.name} pridal komentár k ${own ? 'vašej ' : ''}fotke ${title ? `"${title} "` : ''}na ${webBaseUrl}/?image=${ctx.params.id}:\n\n${comment}`,
        });

        const promises = [];
        if (email && userId !== ctx.state.user.id) {
          promises.push(sendMail(email, true));
        }

        promises.push(...emails.map(({ email: to }) => sendMail(to, false)));

        await Promise.all(promises);
      }

      ctx.body = { id: insertId };
    },
  );
};
