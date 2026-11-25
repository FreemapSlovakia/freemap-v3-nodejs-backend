import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql, { join, type Sql } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { EventFilterSchema } from '../../eventFilter.js';
import { eventUrl } from '../../notificationMail.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { savedFilterSql } from './filterSql.js';
import { icalendar } from './ical.js';
import { eventEndSql } from './types.js';

const CalendarRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  startAt: z.date(),
  endAt: z.date().nullable(),
  dateOnly: z.boolean(),
  startLat: z.number(),
  startLon: z.number(),
  updatedAt: z.date(),
  userName: z.string(),
});

const calendarSelect = sql`
  SELECT e.id, e.title, e.description, e.startAt, e.endAt, e.dateOnly,
    e.startLat, e.startLon, e.updatedAt, u.name AS userName
  FROM event e JOIN user u ON u.id = e.userId`;

// A feed keeps a month of ended events, so a calendar doesn't drop them at once.
const FEED_HISTORY_MS = 30 * 86_400_000;

const FEED_LIMIT = 1000;

function sendCalendar(
  ctx: ParameterizedContext,
  name: string,
  rows: unknown,
  filename: string,
  disposition: 'inline' | 'attachment',
) {
  const events = CalendarRowSchema.array()
    .parse(rows)
    .map(({ userName, ...e }) => ({
      ...e,
      organizer: userName,
      url: eventUrl(e.id),
    }));

  ctx.set('Content-Type', 'text/calendar; charset=utf-8');

  ctx.set('Content-Disposition', `${disposition}; filename="${filename}"`);

  ctx.set('Cache-Control', 'private, no-cache');

  ctx.body = icalendar(name, events, new Date());
}

const FeedQuerySchema = z.object({
  // A saved filter of the token's user; without it, the events the user
  // organizes, is going to or interested in.
  filter: z.coerce.number().int().positive().optional(),
  // The calendar's name, as the web words it in the user's language.
  name: z.string().trim().min(1).max(100).optional(),
});

/** The events as iCalendar: one event to add, or a feed to subscribe to. */
export function attachCalendarHandlers(router: RouterInstance) {
  registerPath('/events/calendar.ics', {
    get: {
      summary:
        "A calendar feed of the user's events or of a saved filter's; for a calendar app, the token goes in `authToken`",
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { query: FeedQuerySchema },
      responses: {
        200: { content: { 'text/calendar': {} } },
        404: { description: 'no such saved filter' },
      },
    },
  });

  router.get(
    '/calendar.ics',
    authenticator(true, 'events:calendar'),
    async (ctx) => {
      let query;

      try {
        query = FeedQuerySchema.parse(ctx.query);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const user = ctx.state.user!;

      const now = new Date();

      const since = new Date(now.getTime() - FEED_HISTORY_MS);

      let wh: Sql[];

      let name = query.name;

      if (query.filter === undefined) {
        wh = [
          sql`${eventEndSql} >= ${since}`,
          sql`(e.userId = ${user.id} OR EXISTS (SELECT 1 FROM eventParticipant p WHERE p.eventId = e.id AND p.userId = ${user.id}))`,
        ];
      } else {
        const [row] = z
          .array(z.object({ name: z.string(), filter: z.unknown() }))
          .parse(
            await pool.query<unknown>(
              sql`SELECT name, filter FROM eventFilter WHERE id = ${query.filter} AND userId = ${user.id}`,
            ),
          );

        if (!row) {
          return ctx.throw(404, 'no such saved filter');
        }

        wh = savedFilterSql(
          EventFilterSchema.parse(
            typeof row.filter === 'string'
              ? JSON.parse(row.filter)
              : row.filter,
          ),
          now,
          since,
        );

        name ??= row.name;
      }

      const rows = await pool.query<unknown>(sql`
        ${calendarSelect}
        WHERE ${join(wh, ' AND ')}
        -- Past the limit, the ended ones go first, then the farthest.
        ORDER BY ${eventEndSql} < ${now}, e.startAt
        LIMIT ${FEED_LIMIT}
      `);

      sendCalendar(
        ctx,
        name ?? 'Freemap',
        rows,
        'freemap-events.ics',
        'inline',
      );
    },
  );

  registerPath('/events/{id}/calendar.ics', {
    get: {
      summary: 'An event as iCalendar, to add to a calendar',
      tags: ['events'],
      requestParams: { path: z.object({ id: z.string().nonempty() }) },
      responses: {
        200: { content: { 'text/calendar': {} } },
        404: { description: 'no such event' },
      },
    },
  });

  router.get('/:id/calendar.ics', async (ctx) => {
    const [row] = z
      .array(z.object({ id: z.string(), title: z.string() }).loose())
      .parse(
        await pool.query<unknown>(
          sql`${calendarSelect} WHERE e.id = ${ctx.params.id}`,
        ),
      );

    if (!row) {
      return ctx.throw(404, 'no such event');
    }

    // A download: the web's link is cross-origin, so its `download` is ignored.
    sendCalendar(ctx, row.title, [row], `freemap-${row.id}.ics`, 'attachment');
  });
}
