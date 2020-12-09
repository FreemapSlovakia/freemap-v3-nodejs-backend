import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { acceptValidator, bodySchemaValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { PoolConnection } from 'mariadb';
import { getEnv } from '../../env';
import got from 'got';

const webBaseUrls = getEnv('WEB_BASE_URL').split(',');

export function attachPostPictureCommentHandler(router: Router) {
  router.post(
    '/pictures/:id/comments',
    authenticator(true),
    bodySchemaValidator(
      {
        type: 'object',
        required: ['comment'],
        properties: {
          webBaseUrl: {
            type: 'string',
            format: 'uri',
          },
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
    async (ctx) => {
      const conn = ctx.state.dbConn as PoolConnection;

      const { comment, webBaseUrl: webBaseUrlCandidate } = ctx.request.body;

      let webBaseUrl: string;

      if (webBaseUrlCandidate !== undefined) {
        if (!webBaseUrls.includes(webBaseUrlCandidate)) {
          ctx.throw(403, 'invalid webBaseUrl');
        }

        webBaseUrl = webBaseUrlCandidate;
      } else {
        webBaseUrl = webBaseUrls[0];
      }

      const proms: Promise<any>[] = [
        conn.query(SQL`
          INSERT INTO pictureComment SET
            pictureId = ${ctx.params.id},
            userId = ${ctx.state.user.id},
            comment = ${comment},
            createdAt = ${new Date()}
        `),
      ];

      if (getEnv('MAILGIN_ENABLE', '')) {
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
          got.post(
            `https://api.mailgun.net/v3/${getEnv('MAILGIN_DOMAIN')}/messages`,
            {
              username: 'api',
              password: getEnv('MAILGIN_API_KEY'),
              form: {
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
              },
            },
          );

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
