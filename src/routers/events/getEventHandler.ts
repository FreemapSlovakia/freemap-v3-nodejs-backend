import type { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  canWriteEvent,
  EVENT_COLUMNS_SQL,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
} from './types.js';

export function attachGetEventHandler(router: RouterInstance) {
  registerPath('/events/{mapId}', {
    get: {
      summary: "Get a map's event",
      tags: ['events'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({ mapId: z.string().nonempty() }),
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        404: { description: 'no such event' },
      },
    },
  });

  router.get(
    '/:mapId',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [row] = EventRowSchema.array()
        .max(1)
        .parse(
          await pool.query<unknown>(sql`
            SELECT ${raw(EVENT_COLUMNS_SQL)}
            FROM mapEvent e JOIN map ON map.id = e.mapId
            WHERE e.mapId = ${ctx.params.mapId}
          `),
        );

      // Unlisted only keeps an event out of listings; its link still works.
      if (!row) {
        ctx.throw(404, 'no such event');
      }

      ctx.body = eventRowToResponse(row, canWriteEvent(ctx.state.user, row));
    },
  );
}
