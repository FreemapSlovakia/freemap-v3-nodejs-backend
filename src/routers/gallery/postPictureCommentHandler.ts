import Router from '@koa/router';
import { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { getEnv, getEnvBoolean } from '../../env.js';
import { sendMail } from '../../mailer.js';
import {
  acceptValidator,
  bodySchemaValidator,
} from '../../requestValidators.js';

const webBaseUrls = getEnv('WEB_BASE_URL').split(',').filter(Boolean);

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

      const [row] = await conn.query(
        sql`SELECT premium FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!row) {
        ctx.throw(404);
      }

      const user = ctx.state.user!;

      if (
        row.premium &&
        (!user.premiumExpiration || user.premiumExpiration < new Date()) &&
        user.id !== row.userId
      ) {
        ctx.throw(402);
      }

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
        conn.query(sql`
          INSERT INTO pictureComment SET
            pictureId = ${ctx.params.id},
            userId = ${user!.id},
            comment = ${comment},
            createdAt = ${new Date()}
        `),
      ];

      if (getEnvBoolean('MAILGIN_ENABLE', false)) {
        proms.push(
          conn.query(sql`
            SELECT IF(sendGalleryEmails, email, NULL) AS email, language, title, userId
              FROM user
              JOIN picture ON userId = user.id
              WHERE picture.id = ${ctx.params.id}
          `),

          conn.query(sql`
            SELECT DISTINCT email, sendGalleryEmails, language
              FROM user
              JOIN pictureComment ON userId = user.id
              WHERE sendGalleryEmails AND pictureId = ${ctx.params.id} AND userId <> ${user!.id} AND email IS NOT NULL
          `),
        );
      }

      const [{ insertId }, [picInfo] = [], emails = []] =
        await Promise.all(proms);

      async function sendCommentMail(to: string, own: boolean, lang: string) {
        ctx.log.info({ to, lang, own }, 'Sending picture comment mail.');

        const picTitle = picInfo.title ? `"${picInfo.title} "` : '';

        const picUrl = webBaseUrl + '/?image=' + ctx.params.id;

        const unsubscribeUrl = webBaseUrl;

        await sendMail(
          to, // TODO translate for HU and IT
          lang === 'sk'
            ? `Komentár k fotke na ${webUrl}`
            : lang === 'cs'
              ? `Komentář k fotce na ${webUrl}`
              : `Photo comment at ${webUrl}`,
          // TODO translate for HU and IT
          (lang === 'sk'
            ? `Používateľ ${user!.name} pridal komentár k ${
                own ? 'vašej ' : ''
              }fotke ${picTitle}na ${picUrl}:`
            : lang === 'cs'
              ? `Uživatel ${user!.name} přidal komentář k ${
                  own ? 'vaší ' : ''
                }fotce ${picTitle}na ${picUrl}:`
              : `User ${user!.name} commented ${
                  own ? 'your' : 'a'
                } photo ${picTitle}at ${picUrl}:`) +
            '\n\n' +
            comment +
            '\n\n' +
            // TODO translate for HU and IT
            (lang === 'sk'
              ? `Ak si už neprajete dostávať upozornenia na komentáre k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`
              : lang === 'cs'
                ? `Pokud si již nepřejete dostávat upozornění na komentáře k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`
                : `If you no longer wish to be notified about photo comments, uncheck it at ${unsubscribeUrl} in the Photos menu.`),
        );
      }

      const acceptLang = ctx.acceptsLanguages(['en', 'sk', 'cs', 'hu']) || 'en';

      const promises: Promise<void>[] = [];

      if (picInfo && picInfo.email && picInfo.userId !== user.id) {
        promises.push(
          sendCommentMail(picInfo.email, true, picInfo.language || acceptLang),
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
          }) =>
            sendCommentMail(
              to,
              false,
              language || picInfo.language || acceptLang,
            ),
        ),
      );

      await Promise.all(promises);

      ctx.body = { id: insertId };
    },
  );
}
