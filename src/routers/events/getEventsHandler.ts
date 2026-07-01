import { RouterInstance } from '@koa/router';
import sql, { empty, join, raw } from 'sql-template-tag';
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
  VisibilitySchema,
} from './types.js';

const QuerySchema = z.object({
  // Time window; an event matches when its [startAt, endAt] span overlaps it
  // (endAt defaults to startAt for instant events).
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  // minLon,minLat,maxLon,maxLat — matched against filterLocation.
  bbox: z
    .string()
    .transform((s) => s.split(',').map(Number))
    .pipe(z.number().array().length(4))
    .optional(),
  visibility: VisibilitySchema.optional(),
  ownerId: z.coerce.number().int().positive().optional(),
});

export function attachGetEventsHandler(router: RouterInstance) {
  registerPath('/events', {
    get: {
      summary: 'List events with time-window / bbox / visibility filters',
      tags: ['events'],
      security: AUTH_OPTIONAL,
      requestParams: { query: QuerySchema },
      responses: {
        200: {
          content: { 'application/json': { schema: EventSchema.array() } },
        },
      },
    },
  });

  router.get(
    '/',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      let query;

      try {
        query = QuerySchema.parse(ctx.query);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { from, to, bbox, visibility, ownerId } = query;

      const myUserId = ctx.state.user?.id ?? -1;

      const wh = [
        // Unlisted events are surfaced in listings only to their owner.
        sql`(visibility = 'public' OR ownerId = ${myUserId})`,
      ];

      if (visibility !== undefined) {
        wh.push(sql`visibility = ${visibility}`);
      }

      if (ownerId !== undefined) {
        wh.push(sql`ownerId = ${ownerId}`);
      }

      if (from) {
        wh.push(sql`COALESCE(endAt, startAt) >= ${new Date(from)}`);
      }

      if (to) {
        wh.push(sql`startAt <= ${new Date(to)}`);
      }

      if (bbox) {
        const [minLon, minLat, maxLon, maxLat] = bbox;

        wh.push(
          sql`filterLat BETWEEN ${minLat} AND ${maxLat} AND filterLon BETWEEN ${minLon} AND ${maxLon}`,
        );
      }

      const rows = EventRowSchema.array().parse(
        await pool.query<unknown>(sql`
          SELECT ${raw(EVENT_COLUMNS_SQL)} FROM event
          ${wh.length ? sql`WHERE ${join(wh, ' AND ')}` : empty}
          ORDER BY startAt
          LIMIT 1000
        `),
      );

      ctx.body = rows.map((row) =>
        eventRowToResponse(
          row,
          isOwnerOrRole(ctx.state.user, row.ownerId, 'mapModerator'),
        ),
      );
    },
  );
}
