import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import config from 'config';
import Mailgun from 'mailgun-js';
import { runInTransaction } from '../../database';
import { acceptValidator, bodySchemaValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { PoolConnection } from 'mariadb';

const webBaseUrl = config.get('webBaseUrl') as string;
const mailgunConfig = config.get('mailgun') as Mailgun.ConstructorParams;

const mailgun = !mailgunConfig ? null : Mailgun(mailgunConfig);

export function attachPostPictureCommentHandler(router: Router) {
  router.post(
    '/pictures/:id/comments',
    authenticator(true),
    bodySchemaValidator(
      {
        type: 'object',
        required: ['comment'],
        properties: {
          comment: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
        },
      },
      true,
    ),
    acceptValidator('application/json'),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn as PoolConnection;

      const { comment } = ctx.request.body;

      const proms: Promise<any>[] = [
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

        const sendMail = (to: string, own: boolean) =>
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

        promises.push(
          ...emails.map(({ email: to }: { email: string }) =>
            sendMail(to, false),
          ),
        );

        await Promise.all(promises);
      }

      ctx.body = { id: insertId };
    },
  );
}
