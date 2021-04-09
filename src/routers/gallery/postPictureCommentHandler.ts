import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { acceptValidator, bodySchemaValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { PoolConnection } from 'mariadb';
import { getEnv } from '../../env';
import got from 'got';
import { userInfo } from 'node:os';

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

      const webUrl = webBaseUrl.replace(/^https?:\/\//, '');

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
            SELECT IF(sendGalleryEmails, email, NULL) AS email, language, title, userId
              FROM user
              JOIN picture ON userId = user.id
              WHERE picture.id = ${ctx.params.id}
          `),

          conn.query(SQL`
            SELECT DISTINCT email, sendGalleryEmails, language
              FROM user
              JOIN pictureComment ON userId = user.id
              WHERE sendGalleryEmails AND pictureId = ${ctx.params.id} AND userId <> ${ctx.state.user.id} AND email IS NOT NULL
          `),
        );
      }

      const [{ insertId }, [picInfo] = [], emails = []] = await Promise.all(
        proms,
      );

      const sendMail = (to: string, own: boolean, lang: string) => {
        ctx.log.info({ to, lang, own }, 'Sending picture comment mail.');

        const picTitle = picInfo.title ? `"${picInfo.title} "` : '';

        const picUrl = webBaseUrl + '/?image=' + ctx.params.id;

        const unsubscribeUrl = webBaseUrl + '/?show=settings';

        return got.post(
          `https://api.mailgun.net/v3/${getEnv('MAILGIN_DOMAIN')}/messages`,
          {
            username: 'api',
            password: getEnv('MAILGIN_API_KEY'),
            form: {
              from:
                // TODO translate for HU
                (lang === 'sk' || lang === 'cs'
                  ? 'Freemap Fotky'
                  : 'Freemap Photos') + ' <noreply@freemap.sk>',
              to,
              subject:
                // TODO translate for HU
                lang === 'sk'
                  ? `Komentár k fotke na ${webUrl}`
                  : lang === 'cs'
                  ? `Komentář k fotce na ${webUrl}`
                  : `Photo comment at ${webUrl}`,
              text:
                // TODO translate for HU
                (lang === 'sk'
                  ? `Používateľ ${ctx.state.user.name} pridal komentár k ${
                      own ? 'vašej ' : ''
                    }fotke ${picTitle}na ${picUrl}:`
                  : lang === 'cs'
                  ? `Uživatel ${ctx.state.user.name} přidal komentář k ${
                      own ? 'vaší ' : ''
                    }fotce ${picTitle}na ${picUrl}:`
                  : `User ${ctx.state.user.name} commented ${
                      own ? 'your' : 'a'
                    } photo ${picTitle}at ${picUrl}:`) +
                '\n\n' +
                comment +
                '\n\n' +
                // TODO translate for HU
                (lang === 'sk'
                  ? `Ak si už neprajete dostávať upozornenia na komentáre k fotkám, nastavte si to na ${unsubscribeUrl} v záložke Účet.`
                  : lang === 'cs'
                  ? 'Pokud si již nepřejete dostávat upozornění na komentáře k fotkám, nastavte si to na ${unsubscribeUrl} v záložce Účet.'
                  : `If you no longer wish to be notified about photo comments, configure it at ${unsubscribeUrl} in the Account tab.`),
            },
          },
        );
      };

      const acceptLang = ctx.acceptsLanguages(['en', 'sk', 'cs', 'hu']) || 'en';

      const promises = [];

      if (picInfo && picInfo.email && picInfo.userId !== ctx.state.user.id) {
        promises.push(
          sendMail(picInfo.email, true, picInfo.language || acceptLang),
        );
      }

      promises.push(
        ...emails.map(
          ({
            email: to,
            language,
          }: {
            email: string;
            language: string | null;
          }) => sendMail(to, false, language || picInfo.language || acceptLang),
        ),
      );

      await Promise.all(promises);

      ctx.body = { id: insertId };
    },
  );
}
