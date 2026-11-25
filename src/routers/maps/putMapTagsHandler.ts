import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { MapTagsSchema, setMapTags } from './tags.js';

export function attachPutMapTagsHandler(router: RouterInstance) {
  registerPath('/maps/{id}/tags', {
    put: {
      summary:
        "Replace the caller's own tags of a map they own or may write; nobody else sees them",
      tags: ['maps'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.string().nonempty(),
        }),
      },
      requestBody: {
        content: { 'application/json': { schema: MapTagsSchema } },
      },
      responses: {
        204: {},
        400: {},
        401: {},
        403: {},
        404: { description: 'no such map' },
      },
    },
  });

  router.put('/:id/tags', authenticator(true, 'maps:write'), async (ctx) => {
    let tags;

    try {
      tags = MapTagsSchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const { id } = ctx.params;

    const userId = ctx.state.user!.id;

    await runInTransaction(async (conn) => {
      const [item] = await conn.query<
        { userId: number; writable: number }[]
      >(sql`
        SELECT userId, EXISTS (SELECT 1 FROM mapWriteAccess WHERE mapId = ${id} AND userId = ${userId}) AS writable
          FROM map WHERE id = ${id} AND NOT forEvent LOCK IN SHARE MODE
      `);

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      // Only maps that are in the caller's list.
      if (item.userId !== userId && !item.writable) {
        ctx.throw(403);
      }

      await setMapTags(conn, id, userId, tags);
    });

    ctx.status = 204;
  });
}
