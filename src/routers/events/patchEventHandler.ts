import type { RouterInstance } from '@koa/router';
import sql, { join, raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { assertOwnMap } from './mapLink.js';
import {
  canWriteEvent,
  EVENT_COLUMNS_SQL,
  EVENT_FROM_SQL,
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
        404: { description: 'no such event or map' },
        409: { description: 'the linked map is not public' },
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

      await runInTransaction(async (conn) => {
        const [existing] = z
          .array(
            z.object({
              userId: z.uint32(),
              mapId: z.string().nullable(),
              startAt: z.date(),
              endAt: z.date().nullable(),
            }),
          )
          .max(1)
          .parse(
            await conn.query<unknown>(
              sql`SELECT userId, mapId, startAt, endAt FROM event WHERE id = ${id} FOR UPDATE`,
            ),
          );

        if (!existing) {
          ctx.throw(404, 'no such event');
        }

        if (!canWriteEvent(ctx.state.user, existing)) {
          ctx.throw(403);
        }

        // Either bound may change alone, so the range is checked as it ends up.
        const startAt = body.startAt
          ? new Date(body.startAt)
          : existing.startAt;

        const endAt =
          body.endAt === undefined
            ? existing.endAt
            : body.endAt
              ? new Date(body.endAt)
              : null;

        if (endAt && endAt < startAt) {
          ctx.throw(400, 'endAt is before startAt');
        }

        if (body.mapId && body.mapId !== existing.mapId) {
          await assertOwnMap(ctx, conn, body.mapId, existing.userId);
        }

        const sets: Sql[] = [];

        const set = (column: string, value: unknown) =>
          sets.push(sql`${raw(column)} = ${value}`);

        const date = (s: string | null | undefined) => (s ? new Date(s) : null);

        if (body.mapId !== undefined) {
          set('mapId', body.mapId);
        }

        if (body.title !== undefined) {
          set('title', body.title);
        }

        if (body.description !== undefined) {
          set('description', body.description);
        }

        if (body.startAt !== undefined) {
          set('startAt', date(body.startAt));
        }

        if (body.endAt !== undefined) {
          set('endAt', date(body.endAt));
        }

        if (body.startPoint !== undefined) {
          set('startLat', body.startPoint.lat);
          set('startLon', body.startPoint.lon);
        }

        if (body.visibility !== undefined) {
          set('visibility', body.visibility);
        }

        if (body.transports !== undefined) {
          set(
            'transports',
            body.transports.length ? body.transports.join(',') : null,
          );
        }

        for (const key of [
          'distance',
          'duration',
          'ascent',
          'descent',
          'difficulty',
          'dogs',
          'children',
        ] as const) {
          if (body[key] !== undefined) {
            set(key, body[key]);
          }
        }

        if (sets.length) {
          await conn.query<unknown>(
            sql`UPDATE event SET ${join(sets, ', ')} WHERE id = ${id}`,
          );
        }

        const [row] = EventRowSchema.array()
          .length(1)
          .parse(
            await conn.query<unknown>(sql`
              SELECT ${raw(EVENT_COLUMNS_SQL)}
              FROM ${raw(EVENT_FROM_SQL)}
              WHERE e.id = ${id}
            `),
          );

        ctx.body = eventRowToResponse(row, ctx.state.user);
      });
    },
  );
}
