import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  DifficultySchema,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
  eventSelect,
  VisibilitySchema,
} from './types.js';

const QuerySchema = z.object({
  // Time window; an event matches when its [startAt, endAt] span overlaps it
  // (endAt defaults to startAt for instant events).
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  // minLon,minLat,maxLon,maxLat — matched against the start point.
  bbox: z
    .string()
    .transform((s) => s.split(',').map(Number))
    .pipe(z.number().array().length(4))
    .optional(),
  // lat,lon — with `radius` (km), matched against the start point.
  near: z
    .string()
    .transform((s) => s.split(',').map(Number))
    .pipe(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
    .optional(),
  radius: z.coerce.number().positive().max(1000).optional(),
  visibility: VisibilitySchema.optional(),
  // Comma-separated transport types; any of them matches.
  transport: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .optional(),
  // Trip-stat ranges, inclusive. An event without the stat never matches one.
  minDistance: z.coerce.number().nonnegative().optional(),
  maxDistance: z.coerce.number().nonnegative().optional(),
  minDuration: z.coerce.number().nonnegative().optional(),
  maxDuration: z.coerce.number().nonnegative().optional(),
  minAscent: z.coerce.number().nonnegative().optional(),
  maxAscent: z.coerce.number().nonnegative().optional(),
  // Comma-separated difficulties; any of them matches.
  difficulty: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(DifficultySchema.array())
    .optional(),
  // `1` only events that said yes, `0` only those that said no; "not said"
  // matches neither.
  dogs: z.enum(['0', '1']).optional(),
  children: z.enum(['0', '1']).optional(),
});

/** The range conditions on one stat column. */
function range(column: string, min?: number, max?: number) {
  return [
    ...(min === undefined ? [] : [sql`${raw(column)} >= ${min}`]),
    ...(max === undefined ? [] : [sql`${raw(column)} <= ${max}`]),
  ];
}

export function attachGetEventsHandler(router: RouterInstance) {
  registerPath('/events', {
    get: {
      summary:
        'List events by time window, area, visibility, transport and trip stats',
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

      const { from, to, bbox, near, radius, visibility } = query;

      const myUserId = ctx.state.user?.id ?? -1;

      const wh = [
        // Unlisted events are listed only to their owner.
        sql`(e.visibility = 'public' OR e.userId = ${myUserId})`,
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
          sql`e.startLat BETWEEN ${minLat} AND ${maxLat} AND e.startLon BETWEEN ${minLon} AND ${maxLon}`,
        );
      }

      if (near) {
        if (radius === undefined) {
          return ctx.throw(400, 'near needs a radius');
        }

        const [lat, lon] = near;

        // The box first, which the start point's index serves; the exact
        // distance only on what it leaves.
        const dLat = radius / 111.2;

        const dLon =
          radius / (111.2 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

        wh.push(
          sql`e.startLat BETWEEN ${lat - dLat} AND ${lat + dLat}`,
          sql`e.startLon BETWEEN ${lon - dLon} AND ${lon + dLon}`,
          sql`ST_Distance_Sphere(POINT(e.startLon, e.startLat), POINT(${lon}, ${lat})) <= ${radius * 1000}`,
        );
      }

      if (query.transport?.length) {
        // Any of them; an event naming none hasn't said, so doesn't match.
        wh.push(
          sql`(${join(
            query.transport.map((t) => sql`FIND_IN_SET(${t}, e.transports)`),
            ' OR ',
          )})`,
        );
      }

      wh.push(
        ...range('e.distance', query.minDistance, query.maxDistance),
        ...range('e.duration', query.minDuration, query.maxDuration),
        ...range('e.ascent', query.minAscent, query.maxAscent),
        ...(query.difficulty?.length
          ? [sql`e.difficulty IN (${join(query.difficulty)})`]
          : []),
        ...(query.dogs ? [sql`e.dogs = ${Number(query.dogs)}`] : []),
        ...(query.children
          ? [sql`e.children = ${Number(query.children)}`]
          : []),
      );

      const rows = EventRowSchema.array().parse(
        await pool.query<unknown>(sql`
          ${eventSelect(ctx.state.user)}
          WHERE ${join(wh, ' AND ')}
          ORDER BY e.startAt
          LIMIT 1000
        `),
      );

      ctx.body = rows.map((row) => eventRowToResponse(row, ctx.state.user));
    },
  );
}
