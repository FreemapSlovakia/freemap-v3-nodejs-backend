import type { PoolConnection } from 'mariadb';
import type { Logger } from 'pino';
import sql, { type Sql } from 'sql-template-tag';
import z from 'zod';
import { afterCommit } from '../../database.js';
import { mailRecipients } from '../../mailWatch.js';
import {
  esc,
  eventUrl,
  formatEventTime,
  htmlPara,
  htmlQuote,
  htmlRef,
  mailInBackground,
  mailTexts,
  sendWatchedMail,
  userUrl,
} from '../../notificationMail.js';

/** A start point moved less than this is the same place. */
const MOVED_M = 200;

const EventWhenSchema = z.object({
  id: z.string(),
  userId: z.uint32(),
  title: z.string(),
  startAt: z.date(),
  endAt: z.date().nullable(),
  dateOnly: z.coerce.boolean(),
  startLat: z.coerce.number(),
  startLon: z.coerce.number(),
});

export type EventWhen = z.infer<typeof EventWhenSchema>;

/** What a change of time or place is judged on, of the event `where` picks. */
export async function readEventWhen(
  conn: PoolConnection,
  where: Sql,
  forUpdate = false,
): Promise<EventWhen | undefined> {
  const [row] = EventWhenSchema.array()
    .max(1)
    .parse(
      await conn.query<unknown>(
        sql`SELECT id, userId, title, startAt, endAt, dateOnly, startLat, startLon
          FROM event WHERE ${where} ${forUpdate ? sql`FOR UPDATE` : sql``}`,
      ),
    );

  return row;
}

const actorRef = (actor: { id: number; name: string }) =>
  htmlRef(actor.name, userUrl(actor.id));

const eventRef = (event: EventWhen) => htmlRef(event.title, eventUrl(event.id));

function distanceM(a: EventWhen, b: EventWhen) {
  const rad = Math.PI / 180;

  const dLat = (b.startLat - a.startLat) * rad;

  const dLon =
    (b.startLon - a.startLon) *
    rad *
    Math.cos(((a.startLat + b.startLat) / 2) * rad);

  return Math.hypot(dLat, dLon) * 6_371_000;
}

export async function mailEventComment(
  conn: PoolConnection,
  logger: Logger,
  opts: {
    eventId: string;
    actor: { id: number; name: string };
    comment: string;
  },
) {
  const event = await readEventWhen(conn, sql`id = ${opts.eventId}`);

  if (!event) {
    return;
  }

  const recipients = await mailRecipients(conn, {
    target: 'event',
    targetId: event.id,
    actorId: opts.actor.id,
  });

  afterCommit(conn, () =>
    mailInBackground(logger, recipients, (r) => {
      const t = mailTexts(r.language);

      const own = r.id === event.userId;

      return sendWatchedMail({
        recipient: r,
        target: 'event',
        targetId: event.id,
        subject: t.commentSubject(event.title),
        body: `${t.commentIntro(opts.actor.name, t.quote(event.title), own)}\n\n${opts.comment}\n\n${t.event}: ${eventUrl(event.id)}`,
        html: [
          htmlPara(t.commentIntro(actorRef(opts.actor), eventRef(event), own)),
          htmlQuote(opts.comment),
        ],
      });
    }),
  );
}

/** Tells the organizer someone is going; not those who follow the event. */
export async function mailEventGoing(
  conn: PoolConnection,
  logger: Logger,
  opts: { eventId: string; actor: { id: number; name: string }; going: number },
) {
  const event = await readEventWhen(conn, sql`id = ${opts.eventId}`);

  if (!event) {
    return;
  }

  const recipients = await mailRecipients(conn, {
    target: 'event',
    targetId: event.id,
    actorId: opts.actor.id,
    candidates: sql`SELECT userId FROM event WHERE id = ${event.id}`,
    watchers: false,
  });

  if (!recipients.length) {
    return;
  }

  // Once per person and event, however often Going is toggled.
  const { affectedRows } = await conn.query<{ affectedRows: number }>(
    sql`INSERT IGNORE INTO eventGoingNotified (eventId, userId)
      VALUES (${event.id}, ${opts.actor.id})`,
  );

  if (!affectedRows) {
    return;
  }

  afterCommit(conn, () =>
    mailInBackground(logger, recipients, (r) => {
      const t = mailTexts(r.language);

      return sendWatchedMail({
        recipient: r,
        target: 'event',
        targetId: event.id,
        subject: t.goingSubject(opts.actor.name, event.title),
        body: `${t.goingBody(opts.actor.name, t.quote(event.title), opts.going)}\n\n${t.event}: ${eventUrl(event.id)}`,
        html: [
          htmlPara(
            t.goingBody(actorRef(opts.actor), eventRef(event), opts.going),
          ),
        ],
      });
    }),
  );
}

/** Mails a change of time or place; anything else changes nothing to mail. */
export async function mailEventChange(
  conn: PoolConnection,
  logger: Logger,
  opts: { before: EventWhen; after: EventWhen; actorId: number },
) {
  const { before, after } = opts;

  const startChanged =
    before.startAt.getTime() !== after.startAt.getTime() ||
    before.dateOnly !== after.dateOnly;

  const endChanged =
    (before.endAt?.getTime() ?? null) !== (after.endAt?.getTime() ?? null) ||
    before.dateOnly !== after.dateOnly;

  const moved = distanceM(before, after) > MOVED_M;

  if (!startChanged && !endChanged && !moved) {
    return;
  }

  const recipients = await mailRecipients(conn, {
    target: 'event',
    targetId: after.id,
    actorId: opts.actorId,
  });

  afterCommit(conn, () =>
    mailInBackground(logger, recipients, (r) => {
      const t = mailTexts(r.language);

      const when = (e: EventWhen, at: Date | null) =>
        at ? formatEventTime(r.language, at, e.dateOnly) : '—';

      const lines = [
        startChanged &&
          `${t.start}: ${when(before, before.startAt)} → ${when(after, after.startAt)}`,
        endChanged &&
          `${t.end}: ${when(before, before.endAt)} → ${when(after, after.endAt)}`,
        moved && t.moved,
      ].filter((line): line is string => typeof line === 'string');

      return sendWatchedMail({
        recipient: r,
        target: 'event',
        targetId: after.id,
        subject: t.changedSubject(after.title),
        body: `${t.changedIntro(t.quote(after.title))}\n\n${lines.join('\n')}\n\n${t.event}: ${eventUrl(after.id)}`,
        html: [
          htmlPara(t.changedIntro(eventRef(after))),
          htmlPara(lines.map(esc).join('<br>')),
        ],
      });
    }),
  );
}

/**
 * Collects who to tell before the event goes, and mails them once it has: the
 * link would lead nowhere, so the mail says what and when it was.
 */
export async function mailEventDeleted(
  conn: PoolConnection,
  logger: Logger,
  opts: { eventId: string; actorId: number },
) {
  const event = await readEventWhen(conn, sql`id = ${opts.eventId}`);

  if (!event) {
    return;
  }

  const recipients = await mailRecipients(conn, {
    target: 'event',
    targetId: event.id,
    actorId: opts.actorId,
  });

  afterCommit(conn, () =>
    mailInBackground(logger, recipients, (r) => {
      const t = mailTexts(r.language);

      const when = formatEventTime(r.language, event.startAt, event.dateOnly);

      return sendWatchedMail({
        recipient: r,
        target: 'event',
        targetId: event.id,
        subject: t.deletedSubject(event.title),
        body: t.deletedBody(t.quote(event.title), when),
        // No link: the event is gone, and with it anything to stop.
        html: [htmlPara(t.deletedBody(htmlRef(event.title), esc(when)))],
        final: true,
      });
    }),
  );
}
