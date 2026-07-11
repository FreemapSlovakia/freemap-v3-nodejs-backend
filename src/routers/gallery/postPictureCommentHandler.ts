import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { getEnv, getEnvBoolean } from '../../env.js';
import { appLogger } from '../../logger.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { COMMENT_MAIL_LANGS, sendCommentMail } from './commentMail.js';
import { parsePictureId } from './pictureId.js';

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
      const ref = parsePictureId(ctx.params.id);

      if (!ref) {
        return ctx.throw(404, 'no such picture');
      }

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

      const user = ctx.state.user!;

      const mailEnabled = getEnvBoolean('MAILGUN_ENABLE', false);

      const acceptLang = ctx.acceptsLanguages([...COMMENT_MAIL_LANGS]) || 'en';

      const picUrl = `${webBaseUrl}/?image=${ctx.params.id}`;

      const logger = appLogger.child({
        module: 'postPictureComment',
        reqId: ctx.reqId,
      });

      // Wikimedia photos have no local uploader, so notifications go only to
      // prior commenters.
      if (ref.source === 'wikimedia') {
        const { insertId, recipients } = await runInTransaction(
          async (conn) => {
            const [row] = await conn.query<{ pageId: number }[]>(
              sql`SELECT pageId FROM wikimediaPicture WHERE pageId = ${ref.pageId} FOR UPDATE`,
            );

            if (!row) {
              ctx.throw(404, 'no such picture');
            }

            const proms = [
              conn.query<{ insertId: number }>(sql`
              INSERT INTO wikimediaComment SET
                pageId = ${ref.pageId},
                userId = ${user.id},
                comment = ${comment},
                createdAt = ${new Date()}
            `),
              ...(mailEnabled
                ? [
                    conn.query<
                      { email: string; language: string | null }[]
                    >(sql`
                    SELECT DISTINCT email, sendGalleryEmails, language
                      FROM user
                      JOIN wikimediaComment ON userId = user.id
                      WHERE sendGalleryEmails AND pageId = ${ref.pageId} AND userId <> ${user.id} AND email IS NOT NULL
                  `),
                  ]
                : ([undefined] as const)),
            ] as const;

            const [{ insertId }, recipients = []] = await Promise.all(proms);

            return { insertId, recipients };
          },
        );

        await Promise.all(
          recipients.map((recipient) => {
            logger.info(
              { to: recipient.email, lang: recipient.language, own: false },
              'Sending picture comment mail.',
            );

            return sendCommentMail({
              to: recipient.email,
              own: false,
              lang: recipient.language || acceptLang,
              commenterName: user.name,
              comment,
              webBaseUrl,
              picUrl,
              picTitle: '',
            });
          }),
        );

        ctx.body = ResponseSchema.parse({ id: insertId });

        return;
      }

      const { insertId, picInfo, recipients } = await runInTransaction(
        async (conn) => {
          const [row] = await conn.query<
            { userId: number; premium: boolean }[]
          >(
            sql`SELECT userId, premium FROM picture WHERE id = ${ref.id} FOR UPDATE`,
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
                pictureId = ${ref.id},
                userId = ${user.id},
                comment = ${comment},
                createdAt = ${new Date()}
            `),
            ...(mailEnabled
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
                      WHERE picture.id = ${ref.id}
                  `),
                  conn.query<{ email: string; language: string | null }[]>(sql`
                    SELECT DISTINCT email, sendGalleryEmails, language
                      FROM user
                      JOIN pictureComment ON userId = user.id
                      WHERE sendGalleryEmails AND pictureId = ${ref.id} AND userId <> ${user.id} AND email IS NOT NULL
                  `),
                ]
              : ([undefined, undefined] as const)),
          ] as const;

          const [{ insertId }, [picInfo] = [], recipients = []] =
            await Promise.all(proms);

          return { insertId, picInfo, recipients };
        },
      );

      const picTitle =
        picInfo && 'title' in picInfo && picInfo.title
          ? `"${picInfo.title}" `
          : '';

      const promises: Promise<void>[] = [];

      if (
        picInfo?.email &&
        (!('userId' in picInfo) || picInfo.userId !== user.id)
      ) {
        logger.info(
          { to: picInfo.email, lang: picInfo.language, own: true },
          'Sending picture comment mail.',
        );

        promises.push(
          sendCommentMail({
            to: picInfo.email,
            own: true,
            lang: picInfo.language || acceptLang,
            commenterName: user.name,
            comment,
            webBaseUrl,
            picUrl,
            picTitle,
          }),
        );
      }

      promises.push(
        ...recipients.map((recipient) => {
          logger.info(
            { to: recipient.email, lang: recipient.language, own: false },
            'Sending picture comment mail.',
          );

          return sendCommentMail({
            to: recipient.email!,
            own: false,
            lang: recipient.language || picInfo?.language || acceptLang,
            commenterName: user.name,
            comment,
            webBaseUrl,
            picUrl,
            picTitle,
          });
        }),
      );

      await Promise.all(promises);

      ctx.body = ResponseSchema.parse({ id: insertId });
    },
  );
}
