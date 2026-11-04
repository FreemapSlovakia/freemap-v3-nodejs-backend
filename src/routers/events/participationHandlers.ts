import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
  eventSelect,
  ParticipationSchema,
} from './types.js';

const IdParamsSchema = z.object({ id: z.string().nonempty() });

const BodySchema = z
  .strictObject({ status: ParticipationSchema })
  .meta({ id: 'EventParticipation' });

/** Sets the caller's participation, or with `null` withdraws it; answers with the event. */
async function setParticipation(
  ctx: ParameterizedContext,
  status: z.infer<typeof ParticipationSchema> | null,
) {
  const { id } = ctx.params;

  const userId = ctx.state.user!.id;

  await runInTransaction(async (conn) => {
    // Unlisted events too: they are open to whoever has the link.
    const [event] = await conn.query<{ id: string }[]>(
      sql`SELECT id FROM event WHERE id = ${id} FOR UPDATE`,
    );

    if (!event) {
      ctx.throw(404, 'no such event');
    }

    await conn.query<unknown>(
      status
        ? sql`INSERT INTO eventParticipant (eventId, userId, status)
            VALUES (${id}, ${userId}, ${status})
            ON DUPLICATE KEY UPDATE status = VALUES(status)`
        : sql`DELETE FROM eventParticipant WHERE eventId = ${id} AND userId = ${userId}`,
    );

    const [row] = EventRowSchema.array()
      .length(1)
      .parse(
        await conn.query<unknown>(
          sql`${eventSelect(ctx.state.user)} WHERE e.id = ${id}`,
        ),
      );

    ctx.body = eventRowToResponse(row, ctx.state.user);
  });
}

export function attachParticipationHandlers(router: RouterInstance) {
  registerPath('/events/{id}/participation', {
    put: {
      summary: 'Say you are interested in an event or going to it',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: IdParamsSchema },
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        404: { description: 'no such event' },
      },
    },
    delete: {
      summary: 'Withdraw your interest in or attendance of an event',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: IdParamsSchema },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        404: { description: 'no such event' },
      },
    },
  });

  router.put(
    '/:id/participation',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      await setParticipation(ctx, body.status);
    },
  );

  router.delete(
    '/:id/participation',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      await setParticipation(ctx, null);
    },
  );
}
