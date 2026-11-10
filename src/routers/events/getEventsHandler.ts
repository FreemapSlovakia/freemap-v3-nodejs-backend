import type { RouterInstance } from '@koa/router';
import sql, { join, raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  DifficultySchema,
  EventRowSchema,
  EventSchema,
  EventSummaryRowSchema,
  EventSummarySchema,
  eventEndSql,
  eventRowToResponse,
  eventSelect,
  eventSummaryRowToResponse,
  eventSummarySelect,
  importedSql,
} from './types.js';

const QuerySchema = z.object({
  // Time window; an event matches when its [startAt, endAt] span overlaps it
  // (one without an end, or a date-only one, lasts its last day through).
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  // The viewer's IANA zone, e.g. `Europe/Bratislava`. With `from`, a
  // date-only event matches by its last date, one without an end by starting
  // on `from`'s day there or later.
  tz: z.string().refine(isTimeZone, 'not an IANA time zone').optional(),
  // `1` lists summaries (`EventSummarySchema`, up to 10000), the full event by
  // its id.
  summary: z.enum(['1']).optional(),
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
  // Words the title holds all of, case and accents ignored.
  q: z.string().trim().min(2).max(100).optional(),
  // `near` orders by distance from `near`, which then needs no `radius`.
  sort: z.enum(['start', 'near']).optional(),
  // At most this many; by default 1000, or 10000 summaries.
  limit: z.coerce.number().int().min(1).max(10000).optional(),
  // Comma-separated transport types; any of them matches.
  transport: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .optional(),
  // Trip-stat ranges, inclusive. An event without the stat matches one only
  // with `unsaid`.
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
  // `1` only imported events (`imported` on Event), `0` only the others.
  imported: z.enum(['0', '1']).optional(),
  // `1` lets events that leave transport, difficulty or a ranged stat unsaid
  // through those filters; dogs and children stay strict.
  unsaid: z.enum(['0', '1']).optional(),
});

/** A zone name; Temporal takes a fixed offset too, which ignores DST. */
function isTimeZone(tz: string) {
  try {
    return /^[a-z]/i.test(tz) && Boolean(Temporal.Now.plainDateISO(tz));
  } catch {
    return false;
  }
}

/** The range conditions on one stat column. */
function range(column: string, min?: number, max?: number) {
  return [
    ...(min === undefined ? [] : [sql`${raw(column)} >= ${min}`]),
    ...(max === undefined ? [] : [sql`${raw(column)} <= ${max}`]),
  ];
}

/** The condition on one column, or it unset where `unsaid` lets that through. */
function orUnsaid(column: string, conds: Sql[], unsaid: boolean): Sql[] {
  if (conds.length === 0) {
    return [];
  }

  const all = sql`(${join(conds, ' AND ')})`;

  return [unsaid ? sql`(${raw(column)} IS NULL OR ${all})` : all];
}

export function attachGetEventsHandler(router: RouterInstance) {
  registerPath('/events', {
    get: {
      summary:
        'List events by time window, area, title words, transport and trip stats',
      tags: ['events'],
      security: AUTH_OPTIONAL,
      requestParams: { query: QuerySchema },
      responses: {
        200: {
          description: 'Events, or with `summary=1` event summaries',
          content: {
            'application/json': {
              schema: z.union([
                EventSchema.array(),
                EventSummarySchema.array(),
              ]),
            },
          },
        },
      },
    },
  });

  router.get(
    '/',
    acceptValidator('application/json'),
    authenticator(false, 'events:read'),
    async (ctx) => {
      let query;

      try {
        query = QuerySchema.parse(ctx.query);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { from, to, tz, bbox, near, radius } = query;

      const wh = [sql`TRUE`];

      if (from && tz) {
        // `from`'s day where the viewer is. Not `Instant.from`, which refuses
        // more than 9 fractional digits.
        const dayStart = Temporal.Instant.fromEpochMilliseconds(
          Date.parse(from),
        )
          .toZonedDateTimeISO(tz)
          .startOfDay();

        // A date-only event's dates are UTC midnights.
        wh.push(sql`CASE
          WHEN e.dateOnly THEN COALESCE(e.endAt, e.startAt) >= ${new Date(`${dayStart.toPlainDate()}T00:00:00Z`)}
          WHEN e.endAt IS NULL THEN e.startAt >= ${new Date(dayStart.epochMilliseconds)}
          ELSE e.endAt >= ${new Date(from)}
        END`);
      } else if (from) {
        wh.push(sql`${eventEndSql} >= ${new Date(from)}`);
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

      if (query.sort === 'near' && !near) {
        return ctx.throw(400, 'sort=near needs near');
      }

      if (query.q) {
        // `\` escapes LIKE's wildcards.
        for (const word of query.q.split(/\s+/)) {
          wh.push(sql`e.title LIKE ${`%${word.replace(/[\\%_]/g, '\\$&')}%`}`);
        }
      }

      if (near && radius === undefined && query.sort !== 'near') {
        return ctx.throw(400, 'near needs a radius');
      }

      if (near && radius !== undefined) {
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

      const unsaid = query.unsaid === '1';

      wh.push(
        // Any of them.
        ...orUnsaid(
          'e.transports',
          query.transport?.length
            ? [
                sql`(${join(
                  query.transport.map(
                    (t) => sql`FIND_IN_SET(${t}, e.transports)`,
                  ),
                  ' OR ',
                )})`,
              ]
            : [],
          unsaid,
        ),
        ...orUnsaid(
          'e.distance',
          range('e.distance', query.minDistance, query.maxDistance),
          unsaid,
        ),
        ...orUnsaid(
          'e.duration',
          range('e.duration', query.minDuration, query.maxDuration),
          unsaid,
        ),
        ...orUnsaid(
          'e.ascent',
          range('e.ascent', query.minAscent, query.maxAscent),
          unsaid,
        ),
        ...orUnsaid(
          'e.difficulty',
          query.difficulty?.length
            ? [sql`e.difficulty IN (${join(query.difficulty)})`]
            : [],
          unsaid,
        ),
        // A yes or no is asked for, so "not said" never matches here.
        ...(query.dogs ? [sql`e.dogs = ${Number(query.dogs)}`] : []),
        ...(query.children
          ? [sql`e.children = ${Number(query.children)}`]
          : []),
        ...(query.imported
          ? [query.imported === '1' ? importedSql : sql`NOT ${importedSql}`]
          : []),
      );

      const orderBy =
        query.sort === 'near' && near
          ? sql`ST_Distance_Sphere(POINT(e.startLon, e.startLat), POINT(${near[1]}, ${near[0]})), e.startAt`
          : sql`e.startAt`;

      if (query.summary === '1') {
        const rows = EventSummaryRowSchema.array().parse(
          await pool.query<unknown>(sql`
            ${eventSummarySelect(ctx.state.user)}
            WHERE ${join(wh, ' AND ')}
            ORDER BY ${orderBy}
            LIMIT ${Math.min(query.limit ?? 10000, 10000)}
          `),
        );

        ctx.body = rows.map(eventSummaryRowToResponse);

        return;
      }

      const rows = EventRowSchema.array().parse(
        await pool.query<unknown>(sql`
          ${eventSelect(ctx.state.user)}
          WHERE ${join(wh, ' AND ')}
          ORDER BY ${orderBy}
          LIMIT ${Math.min(query.limit ?? 1000, 1000)}
        `),
      );

      ctx.body = rows.map((row) => eventRowToResponse(row, ctx.state.user));
    },
  );
}
