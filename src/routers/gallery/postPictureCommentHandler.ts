import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { CommentBodySchema } from '../../comments.js';
import { afterCommit, runInTransaction } from '../../database.js';
import { getEnv } from '../../env.js';
import { appLogger } from '../../logger.js';
import { mailRecipients, unmute } from '../../mailWatch.js';
import { MAIL_LANGS, mailInBackground } from '../../notificationMail.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { sendCommentMail } from './commentMail.js';
import { PictureIdParamSchema, parsePictureId } from './pictureId.js';

const webBaseUrls = getEnv('WEB_BASE_URL').split(',').filter(Boolean);

const BodySchema = z.strictObject({
  ...CommentBodySchema.shape,
  webBaseUrl: z.url().optional(),
});

const ResponseSchema = z.strictObject({ id: z.uint32() });

const logger = appLogger.child({ module: 'postPictureComment' });

export function attachPostPictureCommentHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}/comments', {
    post: {
      summary: 'Post a comment on a gallery picture',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: PictureIdParamSchema }),
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
    authenticator(true, 'gallery:write'),
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

      if (
        webBaseUrlCandidate !== undefined &&
        !webBaseUrls.includes(webBaseUrlCandidate)
      ) {
        ctx.throw(403, 'invalid webBaseUrl');
      }

      const webBaseUrl = webBaseUrlCandidate ?? webBaseUrls[0];

      const user = ctx.state.user!;

      // For a recipient who never chose a language.
      const acceptLang = ctx.acceptsLanguages([...MAIL_LANGS]) || 'en';

      const target = ref.source === 'gallery' ? 'picture' : 'wikimedia';

      const targetId = ref.source === 'gallery' ? ref.id : ref.pageId;

      const picUrl = `${webBaseUrl}/?image=${ref.source === 'gallery' ? ref.id : `w${ref.pageId}`}`;

      const reqLogger = logger.child({ reqId: ctx.reqId });

      const insertId = await runInTransaction(async (conn) => {
        let ownerId: number | null = null;

        let picTitle = '';

        if (ref.source === 'wikimedia') {
          const [row] = await conn.query<{ pageId: number }[]>(
            sql`SELECT pageId FROM wikimediaPicture WHERE pageId = ${ref.pageId} FOR UPDATE`,
          );

          if (!row) {
            ctx.throw(404, 'no such picture');
          }
        } else {
          const [row] = await conn.query<
            { userId: number; premium: boolean; title: string | null }[]
          >(
            sql`SELECT userId, premium, title FROM picture WHERE id = ${ref.id} FOR UPDATE`,
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

          ownerId = row.userId;

          picTitle = row.title ? `"${row.title}" ` : '';
        }

        const { insertId } = await conn.query<{ insertId: number }>(
          ref.source === 'wikimedia'
            ? sql`INSERT INTO wikimediaComment SET
                pageId = ${ref.pageId}, userId = ${user.id}, comment = ${comment}, createdAt = ${new Date()}`
            : sql`INSERT INTO pictureComment SET
                pictureId = ${ref.id}, userId = ${user.id}, comment = ${comment}, createdAt = ${new Date()}`,
        );

        await unmute(conn, user.id, target, targetId);

        const recipients = await mailRecipients(conn, {
          target,
          targetId,
          actorId: user.id,
        });

        afterCommit(conn, () =>
          mailInBackground(reqLogger, recipients, (r) =>
            sendCommentMail({
              recipient: { ...r, language: r.language ?? acceptLang },
              target,
              targetId,
              own: r.id === ownerId,
              commenterName: user.name,
              comment,
              picUrl,
              picTitle,
              web: webBaseUrl,
            }),
          ),
        );

        return insertId;
      });

      ctx.body = ResponseSchema.parse({ id: insertId });
    },
  );
}
