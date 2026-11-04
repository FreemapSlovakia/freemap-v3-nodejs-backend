import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { assertOwnMap } from './mapLink.js';
import { assertCanOwn } from './organizerHandlers.js';
import {
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
  eventSelect,
} from './types.js';
import { EventBodySchema } from './validation.js';

export function attachPostEventHandler(router: RouterInstance) {
  registerPath('/events', {
    post: {
      summary: 'Create an event',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: { 'application/json': { schema: EventBodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        403: { description: 'the linked map is not the user’s own' },
        404: { description: 'no such map' },
      },
    },
  });

  router.post(
    '/',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      let body;

      try {
        body = EventBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const id = nanoid();

      await runInTransaction(async (conn) => {
        const ownerId = body.userId ?? ctx.state.user!.id;

        await assertCanOwn(ctx, conn, ownerId);

        if (body.mapId) {
          await assertOwnMap(ctx, conn, body.mapId, ownerId);
        }

        await conn.query<unknown>(sql`
          INSERT INTO event SET
            id = ${id},
            userId = ${ownerId},
            mapId = ${body.mapId ?? null},
            title = ${body.title},
            description = ${body.description ?? null},
            startAt = ${new Date(body.startAt)},
            endAt = ${body.endAt ? new Date(body.endAt) : null},
            startLat = ${body.startPoint.lat},
            startLon = ${body.startPoint.lon},
            visibility = ${body.visibility},
            transports = ${body.transports?.length ? body.transports.join(',') : null},
            distance = ${body.distance ?? null},
            duration = ${body.duration ?? null},
            ascent = ${body.ascent ?? null},
            descent = ${body.descent ?? null},
            difficulty = ${body.difficulty ?? null},
            dogs = ${body.dogs ?? null},
            children = ${body.children ?? null}
        `);

        const [row] = EventRowSchema.array()
          .length(1)
          .parse(
            await conn.query<unknown>(
              sql`${eventSelect(ctx.state.user)} WHERE e.id = ${id}`,
            ),
          );

        ctx.body = eventRowToResponse(row, ctx.state.user);
      });
    },
  );
}
