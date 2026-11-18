import type { PoolConnection } from 'mariadb';
import sql, { join } from 'sql-template-tag';
import z from 'zod';
import { pool } from './database.js';
import { EventFilterSchema } from './eventFilter.js';
import { EVENT_FILTER_TEXTS } from './eventFilterMailTexts.js';
import { appLogger } from './logger.js';
import { htmlLink, htmlPara, htmlRef } from './mailHtml.js';
import { filterToken } from './mailWatch.js';
import {
  eventUrl,
  formatEventTime,
  mailLang,
  mailTexts,
  sendNotificationMail,
} from './notificationMail.js';
import { savedFilterSql } from './routers/events/filterSql.js';

const logger = appLogger.child({ module: 'eventFilterMail' });

/** Events listed in one email; the rest are counted. */
const MAX_LISTED = 50;

/**
 * Queues each emailing filter's matches among the events added in the last
 * day, but since its `matchSince`, and not the user's own.
 */
// TODO a run could skip when no event was added since the last one; events
// added during a downtime over a day are never matched.
async function queueMatches(conn: PoolConnection) {
  const now = new Date();

  const filters = z
    .array(z.object({ id: z.number(), filter: z.unknown() }))
    .parse(
      await conn.query<unknown>(sql`
        SELECT ef.id, ef.filter
        FROM eventFilter ef JOIN user u ON u.id = ef.userId
        WHERE ef.notify AND u.sendEventEmails AND u.mailableEmail IS NOT NULL
      `),
    );

  for (const row of filters) {
    // One filter gone bad must not stop the others' emails.
    try {
      const filter = EventFilterSchema.parse(
        typeof row.filter === 'string' ? JSON.parse(row.filter) : row.filter,
      );

      // Read, then inserted: an INSERT … SELECT would lock the events read.
      // `u` is the event's owner, which `importedSql` reads.
      const ids = z.array(z.object({ id: z.string() })).parse(
        await conn.query<unknown>(sql`
            SELECT e.id
            FROM event e
            JOIN user u ON u.id = e.userId
            JOIN eventFilter ef ON ef.id = ${row.id}
            WHERE e.createdAt > ${new Date(now.getTime() - 86_400_000)}
              AND e.createdAt >= ef.matchSince
              AND e.userId <> ef.userId
              AND ${join(savedFilterSql(filter, now), ' AND ')}
          `),
      );

      if (ids.length) {
        await conn.query<unknown>(sql`
          INSERT IGNORE INTO eventFilterMatch (filterId, eventId)
          VALUES ${join(ids.map(({ id }) => sql`(${row.id}, ${id})`))}
        `);
      }
    } catch (err) {
      logger.warn({ err, filterId: row.id }, 'saved filter not matched');
    }
  }
}

const RecipientRowSchema = z.object({
  name: z.string(),
  notify: z.coerce.boolean(),
  userId: z.number(),
  email: z.string().nullable(),
  language: z.string().nullable(),
  enabled: z.coerce.boolean(),
});

const EventRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  startAt: z.date(),
  dateOnly: z.coerce.boolean(),
});

/**
 * Mails each filter whose queue has been quiet for 10 minutes, so a burst or
 * a harvest goes out as one email, or whose oldest match waited 2 hours.
 */
async function sendDue(conn: PoolConnection) {
  const due = z.array(z.object({ filterId: z.number() })).parse(
    await conn.query<unknown>(sql`
        SELECT filterId FROM eventFilterMatch
        WHERE sentAt IS NULL
        GROUP BY filterId
        HAVING MAX(createdAt) < NOW() - INTERVAL 10 MINUTE
          OR MIN(createdAt) < NOW() - INTERVAL 2 HOUR
      `),
  );

  for (const { filterId } of due) {
    const [recipient] = RecipientRowSchema.array().parse(
      await conn.query<unknown>(sql`
        SELECT ef.name, ef.notify, u.id AS userId, u.mailableEmail AS email,
          u.language, u.sendEventEmails AS enabled
        FROM eventFilter ef JOIN user u ON u.id = ef.userId
        WHERE ef.id = ${filterId}
      `),
    );

    // As they are now: not deleted since, still on the events they were.
    // TODO an event edited since it was queued is not matched again.
    const events = EventRowSchema.array().parse(
      await conn.query<unknown>(sql`
        SELECT e.id, e.title, e.startAt, e.dateOnly
        FROM eventFilterMatch m JOIN event e ON e.id = m.eventId
        WHERE m.filterId = ${filterId} AND m.sentAt IS NULL
        ORDER BY e.startAt
      `),
    );

    // Marked first: a failing send must not repeat every minute.
    await conn.query<unknown>(sql`
      UPDATE eventFilterMatch SET sentAt = NOW()
      WHERE filterId = ${filterId} AND sentAt IS NULL
    `);

    if (
      !recipient?.notify ||
      !recipient.enabled ||
      !recipient.email ||
      !events.length
    ) {
      continue;
    }

    try {
      await mailMatches(
        { ...recipient, email: recipient.email },
        filterId,
        events,
      );
    } catch (err) {
      logger.error({ err, filterId }, 'saved filter mail failed');
    }
  }
}

async function mailMatches(
  r: z.infer<typeof RecipientRowSchema> & { email: string },
  filterId: number,
  events: z.infer<typeof EventRowSchema>[],
) {
  const t = EVENT_FILTER_TEXTS[mailLang(r.language)];

  const listed = events.slice(0, MAX_LISTED);

  const rest = events.length - listed.length;

  const when = (e: (typeof events)[number]) =>
    formatEventTime(r.language, e.startAt, e.dateOnly);

  await sendNotificationMail({
    recipient: { id: r.userId, email: r.email, language: r.language },
    subject: t.subject(r.name),
    body: [
      t.intro(mailTexts(r.language).quote(r.name)),
      '',
      ...listed.map((e) => `${e.title} — ${when(e)}\n${eventUrl(e.id)}`),
      ...(rest ? ['', t.more(rest)] : []),
    ].join('\n'),
    html: [
      htmlPara(t.intro(htmlRef(r.name))),
      htmlPara(
        listed
          .map((e) => `${htmlLink(eventUrl(e.id), e.title)} — ${when(e)}`)
          .join('<br>'),
      ),
      ...(rest ? [htmlPara(t.more(rest))] : []),
    ],
    stopLabel: t.stop,
    token: filterToken(r.userId, filterId),
  });
}

let running = false;

async function run() {
  if (running) {
    return;
  }

  running = true;

  let conn: PoolConnection | undefined;

  try {
    conn = await pool.getConnection();

    // One API process at a time.
    const [lock] = await conn.query<{ locked: number | null }[]>(
      sql`SELECT GET_LOCK('eventFilterMail', 0) AS locked`,
    );

    if (!lock?.locked) {
      return;
    }

    try {
      await queueMatches(conn);

      await sendDue(conn);

      await conn.query<unknown>(
        sql`DELETE FROM eventFilterMatch WHERE sentAt < NOW() - INTERVAL 2 DAY`,
      );
    } finally {
      await conn.query<unknown>(sql`SELECT RELEASE_LOCK('eventFilterMail')`);
    }
  } catch (err) {
    logger.error({ err }, 'saved filter mail run failed');
  } finally {
    conn?.release();

    running = false;
  }
}

/** Matches and mails every minute. */
export function startEventFilterMail() {
  setInterval(() => void run(), 60_000);
}
