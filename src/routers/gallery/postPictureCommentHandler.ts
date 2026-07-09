import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { getEnv, getEnvBoolean } from '../../env.js';
import { appLogger } from '../../logger.js';
import { sendMail } from '../../mailer.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const webBaseUrls = getEnv('WEB_BASE_URL').split(',').filter(Boolean);

const BodySchema = z.strictObject({
  webBaseUrl: z.url().optional(),
  comment: z.string().min(1).max(4096),
});

const ResponseSchema = z.strictObject({ id: z.uint32() });

export function attachPostPictureCommentHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}/comments', {
    post: {
      summary: 'Post a comment on a gallery picture',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        401: {},
        402: {},
        403: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.post(
    '/pictures/:id/comments',
    authenticator(true),
    acceptValidator('application/json'),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { comment, webBaseUrl: webBaseUrlCandidate } = body;

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

      const user = ctx.state.user!;

      const { insertId, picInfo, recipients } = await runInTransaction(
        async (conn) => {
          const [row] = await conn.query<
            { userId: number; premium: boolean }[]
          >(
            sql`SELECT userId, premium FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
          );

          if (!row) {
            ctx.throw(404, 'no such picture');
          }

          if (
            row.premium &&
            (!user.premiumExpiration || user.premiumExpiration < new Date()) &&
            user.id !== row.userId
          ) {
            ctx.throw(402);
          }

          const proms = [
            conn.query<{ insertId: number }>(sql`
              INSERT INTO pictureComment SET
                pictureId = ${ctx.params.id},
                userId = ${user!.id},
                comment = ${comment},
                createdAt = ${new Date()}
            `),
            ...(getEnvBoolean('MAILGUN_ENABLE', false)
              ? [
                  conn.query<
                    {
                      title: string | null;
                      email: string | null;
                      userId: number | null;
                      language: string | null;
                    }[]
                  >(sql`
                    SELECT IF(sendGalleryEmails, email, NULL) AS email, language, title, userId
                      FROM user
                      JOIN picture ON userId = user.id
                      WHERE picture.id = ${ctx.params.id}
                  `),
                  conn.query<{ email: string; language: string | null }[]>(sql`
                    SELECT DISTINCT email, sendGalleryEmails, language
                      FROM user
                      JOIN pictureComment ON userId = user.id
                      WHERE sendGalleryEmails AND pictureId = ${ctx.params.id} AND userId <> ${user!.id} AND email IS NOT NULL
                  `),
                ]
              : ([undefined, undefined] as const)),
          ] as const;

          const [{ insertId }, [picInfo] = [], recipients = []] =
            await Promise.all(proms);

          return { insertId, picInfo, recipients };
        },
      );

      const logger = appLogger.child({
        module: 'postPictureComment',
        reqId: ctx.reqId,
      });

      type Lang = 'sk' | 'cs' | 'en' | 'hu' | 'it' | 'de' | 'pl' | 'sl' | 'fr';

      async function sendCommentMail(
        to: string,
        own: boolean,
        lang: Lang | string,
      ) {
        logger.info({ to, lang, own }, 'Sending picture comment mail.');

        const picTitle =
          'title' in picInfo && picInfo.title ? `"${picInfo.title} "` : '';

        const picUrl = `${webBaseUrl}/?image=${ctx.params.id}`;

        const unsubscribeUrl = webBaseUrl;

        const subjects: Record<Lang, string> = {
          sk: `Komentár k fotke na ${webUrl}`,
          cs: `Komentář k fotce na ${webUrl}`,
          en: `Photo comment at ${webUrl}`,
          hu: `Hozzászólás a fotóhoz a következőn: ${webUrl}`,
          it: `Commento alla foto su ${webUrl}`,
          de: `Kommentar zu einem Foto auf ${webUrl}`,
          pl: `Komentarz do zdjęcia na ${webUrl}`,
          sl: `Komentar k fotografiji na ${webUrl}`,
          fr: `Commentaire sur une photo sur ${webUrl}`,
        };

        const messages: Record<Lang, string> = {
          sk: `Používateľ ${user!.name} pridal komentár k ${own ? 'vašej ' : ''}fotke ${picTitle}na ${picUrl}:`,
          cs: `Uživatel ${user!.name} přidal komentář k ${own ? 'vaší ' : ''}fotce ${picTitle}na ${picUrl}:`,
          en: `User ${user!.name} commented ${own ? 'your' : 'a'} photo ${picTitle}at ${picUrl}:`,
          hu: `A felhasználó ${user!.name} hozzászólt ${own ? 'az ön' : 'egy'} fotójához: ${picTitle}${picUrl}:`,
          it: `L'utente ${user!.name} ha commentato ${own ? 'la tua' : 'una'} foto ${picTitle}su ${picUrl}:`,
          de: `Benutzer ${user!.name} hat ${own ? 'dein' : 'ein'} Foto kommentiert: ${picTitle}${picUrl}:`,
          pl: `Użytkownik ${user!.name} dodał komentarz do ${own ? 'twojego' : 'zdjęcia'} ${picTitle} na ${picUrl}:`,
          sl: `Uporabnik ${user!.name} je dodal komentar k ${own ? 'vaši ' : ''}fotografiji ${picTitle}na ${picUrl}:`,
          fr: `L'utilisateur ${user!.name} a commenté ${own ? 'votre' : 'une'} photo ${picTitle}sur ${picUrl} :`,
        };

        const footers: Record<Lang, string> = {
          sk: `Ak si už neprajete dostávať upozornenia na komentáre k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`,
          cs: `Pokud si již nepřejete dostávat upozornění na komentáře k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`,
          en: `If you no longer wish to be notified about photo comments, uncheck it at ${unsubscribeUrl} in the Photos menu.`,
          hu: `Ha nem szeretne több értesítést kapni a fotókhoz fűzött hozzászólásokról, kapcsolja ki a beállítást a Fotók menüben: ${unsubscribeUrl}.`,
          it: `Se non desideri più ricevere notifiche sui commenti alle foto, disattiva l'opzione nel menu Foto: ${unsubscribeUrl}.`,
          de: `Wenn du keine Benachrichtigungen über Fotokommentare mehr erhalten möchtest, deaktiviere dies im Menü „Fotos“ unter ${unsubscribeUrl}.`,
          pl: `Jeśli nie chcesz otrzymywać powiadomień o komentarzach do zdjęć, odznacz to w menu Zdjęcia pod adresem ${unsubscribeUrl}.`,
          sl: `Če ne želite več prejemati obvestil o komentarjih k fotografijam, to odznačite na ${unsubscribeUrl} v meniju Fotografije.`,
          fr: `Si vous ne souhaitez plus recevoir de notifications sur les commentaires des photos, décochez cette option dans le menu Photos sur ${unsubscribeUrl}.`,
        };

        await sendMail(
          to,
          subjects[lang as Lang] ?? subjects.en,
          `${messages[lang as Lang] ?? messages.en}\n\n${comment}\n\n${footers[lang as Lang] ?? footers.en}`,
        );
      }

      const acceptLang =
        ctx.acceptsLanguages([
          'en',
          'sk',
          'cs',
          'hu',
          'it',
          'de',
          'pl',
          'sl',
          'fr',
        ]) || 'en';

      const promises: Promise<void>[] = [];
      if (
        picInfo?.email &&
        (!('userId' in picInfo) || picInfo.userId !== user.id)
      ) {
        promises.push(
          sendCommentMail(picInfo.email, true, picInfo.language || acceptLang),
        );
      }

      promises.push(
        ...recipients.map((recipient) =>
          sendCommentMail(
            recipient.email!,
            false,
            recipient.language || picInfo.language || acceptLang,
          ),
        ),
      );

      await Promise.all(promises);

      ctx.body = ResponseSchema.parse({ id: insertId });
    },
  );
}
