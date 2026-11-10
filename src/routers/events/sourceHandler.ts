import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { hasRole } from '../../roles.js';
import { SourceSchema } from './types.js';

const SourceEventSchema = z
  .strictObject({ id: z.string(), sourceKey: z.string() })
  .meta({ id: 'EventOfSource' });

export function attachSourceHandler(router: RouterInstance) {
  registerPath('/events/sources/{source}', {
    get: {
      summary:
        'The events harvested from a source that have not started yet (eventManager only)',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: z.object({ source: SourceSchema }) },
      responses: {
        200: {
          content: {
            'application/json': { schema: SourceEventSchema.array() },
          },
        },
        401: {},
        403: {},
      },
    },
  });

  router.get(
    '/sources/:source',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      if (!hasRole(ctx.state.user, 'eventManager')) {
        return ctx.throw(403);
      }

      const parsed = SourceSchema.safeParse(ctx.params.source);

      if (!parsed.success) {
        return ctx.throw(400, 'bad source');
      }

      const source = parsed.data;

      // Not started yet: only those can vanish from the source, while one
      // under way or over stays as it was.
      ctx.body = SourceEventSchema.array().parse(
        await pool.query<unknown>(
          sql`SELECT id, sourceKey FROM event WHERE sourceKey LIKE ${`${source}:%`} AND startAt > NOW()`,
        ),
      );
    },
  );
}
