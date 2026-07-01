import { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';
import {
  EVENT_COLUMNS_SQL,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
} from './types.js';
import { EventBodySchema } from './validation.js';

export function attachPostEventHandler(router: RouterInstance) {
  registerPath('/events', {
    post: {
      summary: 'Create a new event',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: { 'application/json': { schema: EventBodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        403: { description: 'no access to the referenced map' },
        404: { description: 'no such map' },
      },
    },
  });

  router.post(
    '/',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = EventBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const user = ctx.state.user!;

      const [map] = z
        .array(z.object({ userId: z.uint32() }))
        .max(1)
        .parse(
          await pool.query<unknown>(
            sql`SELECT userId FROM map WHERE id = ${body.mapId}`,
          ),
        );

      if (!map) {
        ctx.throw(404, 'no such map');
      }

      // Only someone who can write the map may publish an event referencing it.
      const canWriteMap =
        isOwnerOrRole(user, map.userId, 'mapModerator') ||
        z
          .array(z.object({ userId: z.uint32() }))
          .parse(
            await pool.query<unknown>(
              sql`SELECT userId FROM mapWriteAccess WHERE mapId = ${body.mapId} AND userId = ${user.id}`,
            ),
          ).length > 0;

      if (!canWriteMap) {
        ctx.throw(403, 'no access to the referenced map');
      }

      const id = nanoid();

      await pool.query<unknown>(sql`
        INSERT INTO event SET
          id = ${id},
          ownerId = ${user.id},
          mapId = ${body.mapId},
          title = ${body.title},
          description = ${body.description ?? null},
          startAt = ${new Date(body.startAt)},
          endAt = ${body.endAt ? new Date(body.endAt) : null},
          startLat = ${body.startPoint?.lat ?? null},
          startLon = ${body.startPoint?.lon ?? null},
          filterLat = ${body.filterLocation?.lat ?? null},
          filterLon = ${body.filterLocation?.lon ?? null},
          visibility = ${body.visibility}
      `);

      const [row] = EventRowSchema.array()
        .max(1)
        .parse(
          await pool.query<unknown>(
            sql`SELECT ${raw(EVENT_COLUMNS_SQL)} FROM event WHERE id = ${id}`,
          ),
        );

      ctx.body = eventRowToResponse(row, true);
    },
  );
}
