import type { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { assertMapWritable } from './mapAccess.js';
import {
  EVENT_COLUMNS_SQL,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
} from './types.js';
import { EventBodySchema } from './validation.js';

export function attachPutEventHandler(router: RouterInstance) {
  registerPath('/events/{mapId}', {
    put: {
      summary: 'Make a map an event, or replace its event',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ mapId: z.string().nonempty() }),
      },
      requestBody: {
        content: { 'application/json': { schema: EventBodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        403: {},
        404: { description: 'no such map' },
      },
    },
  });

  router.put(
    '/:mapId',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = EventBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { mapId } = ctx.params;

      await runInTransaction(async (conn) => {
        await assertMapWritable(ctx, conn, mapId);

        const fields = sql`
          description = ${body.description ?? null},
          startAt = ${new Date(body.startAt)},
          endAt = ${body.endAt ? new Date(body.endAt) : null},
          startLat = ${body.startPoint.lat},
          startLon = ${body.startPoint.lon},
          filterLat = ${body.filterLocation?.lat ?? null},
          filterLon = ${body.filterLocation?.lon ?? null},
          visibility = ${body.visibility}
        `;

        await conn.query<unknown>(sql`
          INSERT INTO mapEvent SET mapId = ${mapId}, ${fields}
          ON DUPLICATE KEY UPDATE ${fields}
        `);

        const [row] = EventRowSchema.array()
          .length(1)
          .parse(
            await conn.query<unknown>(sql`
              SELECT ${raw(EVENT_COLUMNS_SQL)}
              FROM mapEvent e JOIN map ON map.id = e.mapId
              WHERE e.mapId = ${mapId}
            `),
          );

        ctx.body = eventRowToResponse(row, true);
      });
    },
  );
}
