import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
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

      const { from, to, bbox, visibility } = query;

      const myUserId = ctx.state.user?.id ?? -1;

      const wh = [
        // Unlisted events are listed only to those who can write their map.
        sql`(e.visibility = 'public' OR map.userId = ${myUserId} OR EXISTS (
          SELECT 1 FROM mapWriteAccess WHERE mapId = e.mapId AND userId = ${myUserId}
        ))`,
      ];

      if (visibility !== undefined) {
        wh.push(sql`e.visibility = ${visibility}`);
      }

      if (from) {
        wh.push(sql`COALESCE(e.endAt, e.startAt) >= ${new Date(from)}`);
      }

      if (to) {
        wh.push(sql`e.startAt <= ${new Date(to)}`);
      }

      if (bbox) {
        const [minLon, minLat, maxLon, maxLat] = bbox;

        wh.push(
          sql`e.filterLat BETWEEN ${minLat} AND ${maxLat} AND e.filterLon BETWEEN ${minLon} AND ${maxLon}`,
        );
      }

      const rows = EventRowSchema.array().parse(
        await pool.query<unknown>(sql`
          SELECT ${raw(EVENT_COLUMNS_SQL)}
          FROM mapEvent e JOIN map ON map.id = e.mapId
          WHERE ${join(wh, ' AND ')}
          ORDER BY e.startAt
          LIMIT 1000
        `),
      );

      ctx.body = rows.map((row) =>
        eventRowToResponse(row, canWriteEvent(ctx.state.user, row)),
      );
    },
  );
}
