const SQL = require('sql-template-strings');
const config = require('config');
const { runInTransaction } = require('~/database');
const { acceptValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureCommentSchema = require('./postPictureCommentSchema');
const authenticator = require('~/authenticator');

const webBaseUrl = config.get('webBaseUrl');
const mailgunConfig = config.get('mailgun');

const mailgun = !mailgunConfig ? null : require('mailgun-js')(mailgunConfig);

module.exports = function attachPostPictureCommentHandler(router) {
  router.post(
    '/pictures/:id/comments',
    authenticator(true),
    bodySchemaValidator(postPictureCommentSchema, true),
    acceptValidator('application/json'),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn;

      const { comment } = ctx.request.body;

      const proms = [
        conn.query(SQL`
          INSERT INTO pictureComment SET
            pictureId = ${ctx.params.id},
            userId = ${ctx.state.user.id},
            comment = ${comment},
            createdAt = ${new Date()}
        `),
      ];

      if (mailgun) {
        proms.push(
          conn.query(SQL`
            SELECT email, title, userId
              FROM user
              JOIN picture ON userId = user.id
              WHERE picture.id = ${ctx.params.id}
          `),

          conn.query(SQL`
            SELECT DISTINCT email
              FROM user
              JOIN pictureComment ON userId = user.id
              WHERE pictureId = ${ctx.params.id} AND userId <> ${ctx.state.user.id} AND email IS NOT NULL
          `),
        );
      }

      const [{ insertId }, picInfo, emails] = await Promise.all(proms);

      if (picInfo && emails) {
        const [{ email, title, userId }] = picInfo;

        const sendMail = (to, own) =>
          mailgun.messages().send({
            from: 'Freemap Fotky <noreply@freemap.sk>',
            to,
            subject: `Komentár k fotke na ${webBaseUrl.replace(
              /^https?:\/\//,
              '',
            )}`,
            text: `Používateľ ${ctx.state.user.name} pridal komentár k ${
              own ? 'vašej ' : ''
            }fotke ${title ? `"${title} "` : ''}na ${webBaseUrl}/?image=${
              ctx.params.id
            }:\n\n${comment}`,
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
