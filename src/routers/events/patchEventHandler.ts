import { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';
import {
  EVENT_COLUMNS_SQL,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
} from './types.js';
import { EventPatchSchema } from './validation.js';

export function attachPatchEventHandler(router: RouterInstance) {
  registerPath('/events/{id}', {
    patch: {
      summary: 'Update an event (owner only)',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: z.string().nonempty() }),
      },
      requestBody: {
        content: { 'application/json': { schema: EventPatchSchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        403: {},
        404: { description: 'no such event' },
      },
    },
  });

  router.patch(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = EventPatchSchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { id } = ctx.params;

      const user = ctx.state.user!;

      await runInTransaction(async (conn) => {
        const [existing] = EventRowSchema.array()
          .max(1)
          .parse(
            await conn.query<unknown>(
              sql`SELECT ${raw(EVENT_COLUMNS_SQL)} FROM event WHERE id = ${id} FOR UPDATE`,
            ),
          );

        if (!existing) {
          ctx.throw(404, 'no such event');
        }

        if (!isOwnerOrRole(user, existing.ownerId, 'mapModerator')) {
          ctx.throw(403);
        }

        // Repointing the event at a different map requires write access to it.
        if (body.mapId !== undefined && body.mapId !== existing.mapId) {
          const [map] = z
            .array(z.object({ userId: z.uint32() }))
            .max(1)
            .parse(
              await conn.query<unknown>(
                sql`SELECT userId FROM map WHERE id = ${body.mapId}`,
              ),
            );

          if (!map) {
            ctx.throw(404, 'no such map');
          }

          const canWriteMap =
            isOwnerOrRole(user, map.userId, 'mapModerator') ||
            z
              .array(z.object({ userId: z.uint32() }))
              .parse(
                await conn.query<unknown>(
                  sql`SELECT userId FROM mapWriteAccess WHERE mapId = ${body.mapId} AND userId = ${user.id}`,
                ),
              ).length > 0;

          if (!canWriteMap) {
            ctx.throw(403, 'no access to the referenced map');
          }
        }

        const sets = [];

        if (body.mapId !== undefined) {
          sets.push(sql`mapId = ${body.mapId}`);
        }

        if (body.title !== undefined) {
          sets.push(sql`title = ${body.title}`);
        }

        if (body.description !== undefined) {
          sets.push(sql`description = ${body.description ?? null}`);
        }

        if (body.startAt !== undefined) {
          sets.push(sql`startAt = ${new Date(body.startAt)}`);
        }

        if (body.endAt !== undefined) {
          sets.push(sql`endAt = ${body.endAt ? new Date(body.endAt) : null}`);
        }

        if (body.startPoint !== undefined) {
          sets.push(sql`startLat = ${body.startPoint?.lat ?? null}`);
          sets.push(sql`startLon = ${body.startPoint?.lon ?? null}`);
        }

        if (body.filterLocation !== undefined) {
          sets.push(sql`filterLat = ${body.filterLocation?.lat ?? null}`);
          sets.push(sql`filterLon = ${body.filterLocation?.lon ?? null}`);
        }

        if (body.visibility !== undefined) {
          sets.push(sql`visibility = ${body.visibility}`);
        }

        if (sets.length) {
          await conn.query<unknown>(
            sql`UPDATE event SET ${join(sets, ', ')} WHERE id = ${id}`,
          );
        }

        const [row] = EventRowSchema.array()
          .max(1)
          .parse(
            await conn.query<unknown>(
              sql`SELECT ${raw(EVENT_COLUMNS_SQL)} FROM event WHERE id = ${id}`,
            ),
          );

        ctx.body = eventRowToResponse(row, true);
      });
    },
  );
}
