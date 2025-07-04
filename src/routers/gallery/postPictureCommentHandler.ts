import Router from '@koa/router';
import { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { getEnv, getEnvBoolean } from '../../env.js';
import { appLogger } from '../../logger.js';
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

      const logger = appLogger.child({
        module: 'postPictureComment',
        reqId: ctx.reqId,
      });

      type Lang = 'sk' | 'cs' | 'en' | 'hu' | 'it' | 'de' | 'pl';

      async function sendCommentMail(
        to: string,
        own: boolean,
        lang: Lang | string,
      ) {
        logger.info({ to, lang, own }, 'Sending picture comment mail.');

        const picTitle = picInfo.title ? `"${picInfo.title} "` : '';

        const picUrl = webBaseUrl + '/?image=' + ctx.params.id;

        const unsubscribeUrl = webBaseUrl;

        const subjects: Record<Lang, string> = {
          sk: `Komentár k fotke na ${webUrl}`,
          cs: `Komentář k fotce na ${webUrl}`,
          en: `Photo comment at ${webUrl}`,
          hu: `Hozzászólás a fotóhoz a következőn: ${webUrl}`,
          it: `Commento alla foto su ${webUrl}`,
          de: `Kommentar zu einem Foto auf ${webUrl}`,
          pl: `Komentarz do zdjęcia na ${webUrl}`,
        };

        const messages: Record<Lang, string> = {
          sk: `Používateľ ${user!.name} pridal komentár k ${own ? 'vašej ' : ''}fotke ${picTitle}na ${picUrl}:`,
          cs: `Uživatel ${user!.name} přidal komentář k ${own ? 'vaší ' : ''}fotce ${picTitle}na ${picUrl}:`,
          en: `User ${user!.name} commented ${own ? 'your' : 'a'} photo ${picTitle}at ${picUrl}:`,
          hu: `A felhasználó ${user!.name} hozzászólt ${own ? 'az ön' : 'egy'} fotójához: ${picTitle}${picUrl}:`,
          it: `L'utente ${user!.name} ha commentato ${own ? 'la tua' : 'una'} foto ${picTitle}su ${picUrl}:`,
          de: `Benutzer ${user!.name} hat ${own ? 'dein' : 'ein'} Foto kommentiert: ${picTitle}${picUrl}:`,
          pl: `Użytkownik ${user!.name} dodał komentarz do ${own ? 'twojego' : 'zdjęcia'} ${picTitle} na ${picUrl}:`,
        };

        const footers: Record<Lang, string> = {
          sk: `Ak si už neprajete dostávať upozornenia na komentáre k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`,
          cs: `Pokud si již nepřejete dostávat upozornění na komentáře k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`,
          en: `If you no longer wish to be notified about photo comments, uncheck it at ${unsubscribeUrl} in the Photos menu.`,
          hu: `Ha nem szeretne több értesítést kapni a fotókhoz fűzött hozzászólásokról, kapcsolja ki a beállítást a Fotók menüben: ${unsubscribeUrl}.`,
          it: `Se non desideri più ricevere notifiche sui commenti alle foto, disattiva l'opzione nel menu Foto: ${unsubscribeUrl}.`,
          de: `Wenn du keine Benachrichtigungen über Fotokommentare mehr erhalten möchtest, deaktiviere dies im Menü „Fotos“ unter ${unsubscribeUrl}.`,
          pl: `Jeśli nie chcesz otrzymywać powiadomień o komentarzach do zdjęć, odznacz to w menu Zdjęcia pod adresem ${unsubscribeUrl}.`,
        };

        await sendMail(
          to,
          subjects[lang as Lang] ?? subjects.en,
          `${messages[lang as Lang] ?? messages.en}\n\n${comment}\n\n${footers[lang as Lang] ?? footers.en}`,
        );
      }

      const acceptLang =
        ctx.acceptsLanguages(['en', 'sk', 'cs', 'hu', 'it', 'de', 'pl']) ||
        'en';

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
