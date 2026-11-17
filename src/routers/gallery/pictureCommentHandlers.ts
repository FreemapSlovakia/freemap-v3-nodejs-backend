import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import {
  CommentBodySchema,
  CommentSchema,
  deleteComment,
  editComment,
} from '../../comments.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { idParam } from '../../routeParams.js';
import { PictureIdParamSchema, parsePictureId } from './pictureId.js';

const ParamsSchema = z.object({
  id: PictureIdParamSchema,
  commentId: z.uint32(),
});

const responses = {
  200: { content: { 'application/json': { schema: CommentSchema } } },
  401: {},
  403: {},
  404: { description: 'no such comment' },
};

function target(ctx: ParameterizedContext) {
  const ref = parsePictureId(ctx.params.id);

  const commentId = idParam(ctx, 'no such comment', 'commentId');

  if (!ref) {
    return ctx.throw(404, 'no such comment');
  }

  return ref.source === 'gallery'
    ? { table: 'pictureComment' as const, parentId: ref.id, commentId }
    : { table: 'wikimediaComment' as const, parentId: ref.pageId, commentId };
}

export function attachPictureCommentHandlers(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}/comments/{commentId}', {
    patch: {
      summary: 'Edit your comment on a picture, within an hour of posting it',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: { path: ParamsSchema },
      requestBody: {
        content: { 'application/json': { schema: CommentBodySchema } },
      },
      responses,
    },
    delete: {
      summary:
        "Delete a comment on a picture (its author, the picture's owner or a gallery moderator)",
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: { path: ParamsSchema },
      responses,
    },
  });

  router.patch(
    '/pictures/:id/comments/:commentId',
    acceptValidator('application/json'),
    authenticator(true, 'gallery:write'),
    async (ctx) => {
      const t = target(ctx);

      let body;

      try {
        body = CommentBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      ctx.body = await editComment(ctx, t, body.comment);
    },
  );

  router.delete(
    '/pictures/:id/comments/:commentId',
    acceptValidator('application/json'),
    authenticator(true, 'gallery:write'),
    async (ctx) => {
      ctx.body = await deleteComment(ctx, target(ctx));
    },
  );
}
