import { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';
import {
  EVENT_COLUMNS_SQL,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
} from './types.js';

export function attachGetEventHandler(router: RouterInstance) {
  registerPath('/events/{id}', {
    get: {
      summary: 'Get an event by ID',
      tags: ['events'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({ id: z.string().nonempty() }),
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        404: { description: 'no such event' },
      },
    },
  });

  router.get(
    '/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [row] = EventRowSchema.array()
        .max(1)
        .parse(
          await pool.query<unknown>(
            sql`SELECT ${raw(EVENT_COLUMNS_SQL)} FROM event WHERE id = ${ctx.params.id}`,
          ),
        );

      // Both public and unlisted events are readable by direct id — unlisted
      // just means "not surfaced in listings".
      if (!row) {
        ctx.throw(404, 'no such event');
      }

      ctx.body = eventRowToResponse(
        row,
        isOwnerOrRole(ctx.state.user, row.ownerId, 'mapModerator'),
      );
    },
  );
}
