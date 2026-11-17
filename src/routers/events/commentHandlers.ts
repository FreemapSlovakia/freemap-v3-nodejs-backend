import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import {
  CommentBodySchema,
  CommentSchema,
  deleteComment,
  editComment,
  getComment,
  listComments,
} from '../../comments.js';
import { pool, runInTransaction } from '../../database.js';
import { appLogger } from '../../logger.js';
import { unmute } from '../../mailWatch.js';
import { AUTH_OPTIONAL, AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { idParam } from '../../routeParams.js';
import { mailEventComment } from './eventMail.js';

const logger = appLogger.child({ module: 'eventComments' });

const IdParamsSchema = z.object({ id: z.string().nonempty() });

const CommentParamsSchema = z.object({
  ...IdParamsSchema.shape,
  commentId: z.uint32(),
});

const commentResponse = {
  200: { content: { 'application/json': { schema: CommentSchema } } },
  401: {},
  403: {},
  404: { description: 'no such comment' },
};

export function attachCommentHandlers(router: RouterInstance) {
  registerPath('/events/{id}/comments', {
    get: {
      summary: "List an event's discussion, oldest first",
      tags: ['events'],
      security: AUTH_OPTIONAL,
      requestParams: { path: IdParamsSchema },
      responses: {
        200: {
          content: { 'application/json': { schema: CommentSchema.array() } },
        },
        404: { description: 'no such event' },
      },
    },
    post: {
      summary: "Post a comment to an event's discussion",
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: IdParamsSchema },
      requestBody: {
        content: { 'application/json': { schema: CommentBodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: CommentSchema } } },
        401: {},
        404: { description: 'no such event' },
      },
    },
  });

  registerPath('/events/{id}/comments/{commentId}', {
    patch: {
      summary: 'Edit your comment, within an hour of posting it',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: CommentParamsSchema },
      requestBody: {
        content: { 'application/json': { schema: CommentBodySchema } },
      },
      responses: commentResponse,
    },
    delete: {
      summary:
        "Delete a comment (its author, the event's owner or an event manager)",
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: CommentParamsSchema },
      responses: commentResponse,
    },
  });

  router.get(
    '/:id/comments',
    acceptValidator('application/json'),
    authenticator(false, 'events:read'),
    async (ctx) => {
      const { id } = ctx.params;

      const [event] = await pool.query<{ id: string }[]>(
        sql`SELECT id FROM event WHERE id = ${id}`,
      );

      if (!event) {
        ctx.throw(404, 'no such event');
      }

      ctx.body = await listComments(pool, 'eventComment', id);
    },
  );

  router.post(
    '/:id/comments',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      const { id } = ctx.params;

      let body;

      try {
        body = CommentBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      ctx.body = await runInTransaction(async (conn) => {
        const [event] = await conn.query<{ id: string }[]>(
          sql`SELECT id FROM event WHERE id = ${id} FOR UPDATE`,
        );

        if (!event) {
          ctx.throw(404, 'no such event');
        }

        const user = ctx.state.user!;

        const { insertId } = await conn.query<{ insertId: number }>(
          sql`INSERT INTO eventComment (eventId, userId, comment)
            VALUES (${id}, ${user.id}, ${body.comment})`,
        );

        await unmute(conn, user.id, 'event', id);

        await mailEventComment(conn, logger.child({ reqId: ctx.reqId }), {
          eventId: id,
          actor: user,
          comment: body.comment,
        });

        return getComment(conn, 'eventComment', insertId);
      });
    },
  );

  router.patch(
    '/:id/comments/:commentId',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      const commentId = idParam(ctx, 'no such comment', 'commentId');

      let body;

      try {
        body = CommentBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      ctx.body = await editComment(
        ctx,
        { table: 'eventComment', parentId: ctx.params.id, commentId },
        body.comment,
      );
    },
  );

  router.delete(
    '/:id/comments/:commentId',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      const commentId = idParam(ctx, 'no such comment', 'commentId');

      ctx.body = await deleteComment(ctx, {
        table: 'eventComment',
        parentId: ctx.params.id,
        commentId,
      });
    },
  );
}
