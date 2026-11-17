import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolConnection } from 'mariadb';
import sql, { empty, raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import { getEnv } from './env.js';

export const MailTargetSchema = z.enum(['event', 'picture', 'wikimedia']);

export type MailTarget = z.infer<typeof MailTargetSchema>;

type Db = Pool | PoolConnection;

/** The account flag that turns a kind of email off altogether. */
const FLAG: Record<MailTarget, 'sendEventEmails' | 'sendGalleryEmails'> = {
  event: 'sendEventEmails',
  picture: 'sendGalleryEmails',
  wikimedia: 'sendGalleryEmails',
};

/**
 * Who takes part in a target without asking to: an event's organizer, the
 * going and the interested; a photo's uploader. Commenters on either.
 */
function involvedSql(target: MailTarget, targetId: string): Sql {
  switch (target) {
    case 'event':
      return sql`SELECT userId FROM event WHERE id = ${targetId}
        UNION SELECT userId FROM eventParticipant WHERE eventId = ${targetId}
        UNION SELECT userId FROM eventComment WHERE eventId = ${targetId} AND deletedAt IS NULL`;

    case 'picture':
      return sql`SELECT userId FROM picture WHERE id = ${targetId}
        UNION SELECT userId FROM pictureComment WHERE pictureId = ${targetId} AND deletedAt IS NULL`;

    case 'wikimedia':
      return sql`SELECT userId FROM wikimediaComment WHERE pageId = ${targetId} AND deletedAt IS NULL`;
  }
}

export type Recipient = { id: number; email: string; language: string | null };

/**
 * Whom to mail about a target: `candidates` (by default everyone involved)
 * plus those following it, less those who muted it, the actor, and anyone
 * whose account turns that kind of email off or has no confirmed address.
 */
export async function mailRecipients(
  db: Db,
  opts: {
    target: MailTarget;
    targetId: string | number;
    actorId: number | null;
    candidates?: Sql;
    /** Followers too; not for what only the organizer hears of. */
    watchers?: boolean;
  },
): Promise<Recipient[]> {
  const targetId = String(opts.targetId);

  const { target, actorId, watchers = true } = opts;

  const candidates = opts.candidates ?? involvedSql(target, targetId);

  return z
    .array(
      z.object({
        id: z.uint32(),
        email: z.string(),
        language: z.string().nullable(),
      }),
    )
    .parse(
      // Joined from the candidates, not `user` filtered by an OR of INs, which
      // MariaDB may answer with a scan of every user.
      await db.query<unknown>(sql`
        SELECT u.id, u.mailableEmail AS email, u.language
        FROM (
          ${candidates}
          ${watchers ? sql`UNION SELECT userId FROM mailWatch WHERE target = ${target} AND targetId = ${targetId} AND watching` : empty}
        ) c
        JOIN user u ON u.id = c.userId
        WHERE NOT EXISTS (
            SELECT 1 FROM mailWatch m
            WHERE m.userId = u.id AND m.target = ${target} AND m.targetId = ${targetId} AND NOT m.watching
          )
          AND u.id <> ${actorId ?? 0}
          AND u.${raw(FLAG[target])}
          AND u.mailableEmail IS NOT NULL
      `),
    );
}

/**
 * Whether the user gets the emails about a target, and whether that kind is on
 * at all; `null` for no such user.
 */
export async function watchState(
  db: Db,
  userId: number,
  target: MailTarget,
  targetId: string,
) {
  const [row] = z
    .array(
      z.object({
        watching: z.coerce.boolean().nullable(),
        involved: z.coerce.boolean(),
        enabled: z.coerce.boolean(),
      }),
    )
    .max(1)
    .parse(
      await db.query<unknown>(sql`
        SELECT
          -- As a number: the driver reads a subquery's BIT as false.
          (SELECT watching + 0 FROM mailWatch WHERE userId = u.id AND target = ${target} AND targetId = ${targetId}) AS watching,
          u.id IN (${involvedSql(target, targetId)}) AS involved,
          u.${raw(FLAG[target])} AS enabled
        FROM user u WHERE u.id = ${userId}
      `),
    );

  if (!row) {
    return null;
  }

  return {
    watching: row.watching ?? row.involved,
    enabled: row.enabled,
    involved: row.involved,
  };
}

/**
 * Follows or mutes a target. What taking part gives by default is kept as no
 * row, so leaving the event later still stops the emails. `null` for no user.
 */
export async function setWatch(
  db: Db,
  userId: number,
  target: MailTarget,
  targetId: string,
  watching: boolean,
) {
  const state = await watchState(db, userId, target, targetId);

  if (!state) {
    return null;
  }

  // A row for no target would outlive what clears them.
  if (
    watching !== state.involved &&
    !(await targetExists(db, target, targetId))
  ) {
    return { watching: state.watching, enabled: state.enabled };
  }

  await db.query<unknown>(
    watching === state.involved
      ? sql`DELETE FROM mailWatch
          WHERE userId = ${userId} AND target = ${target} AND targetId = ${targetId}`
      : sql`INSERT INTO mailWatch (userId, target, targetId, watching)
          VALUES (${userId}, ${target}, ${targetId}, ${watching})
          ON DUPLICATE KEY UPDATE watching = VALUES(watching)`,
  );

  return { watching, enabled: state.enabled };
}

export async function targetExists(
  db: Db,
  target: MailTarget,
  targetId: string,
) {
  // A Commons photo outlives our monthly import of it, as its comments do.
  if (target === 'wikimedia') {
    return true;
  }

  const [row] = await db.query<unknown[]>(
    target === 'event'
      ? sql`SELECT 1 FROM event WHERE id = ${targetId}`
      : sql`SELECT 1 FROM picture WHERE id = ${targetId}`,
  );

  return row !== undefined;
}

/** Taking part again undoes a mute: a question asked wants its answers. */
export async function unmute(
  db: Db,
  userId: number,
  target: MailTarget,
  targetId: string | number,
) {
  await db.query<unknown>(sql`
    DELETE FROM mailWatch
    WHERE userId = ${userId} AND target = ${target} AND targetId = ${String(targetId)} AND NOT watching
  `);
}

/**
 * A target is gone, so are its followers and mutes.
 * TODO targets deleted otherwise (a user's photos cascading away) leave theirs.
 */
export async function forgetTarget(
  db: Db,
  target: MailTarget,
  targetId: string | number,
) {
  await db.query<unknown>(
    sql`DELETE FROM mailWatch WHERE target = ${target} AND targetId = ${String(targetId)}`,
  );
}

// Read lazily: the API starts without it, and mail then goes out unsigned.
function secret() {
  return getEnv('MAIL_TOKEN_SECRET', '');
}

const sign = (payload: string) =>
  createHmac('sha256', secret())
    .update(`mailWatch:${payload}`)
    .digest('base64url')
    .slice(0, 22);

/**
 * A link's token letting its holder follow or mute one target for one user,
 * without logging in. Never expires: muting is all it can do that matters.
 */
export function watchToken(
  userId: number,
  target: MailTarget,
  targetId: string | number,
): string | null {
  if (!secret()) {
    return null;
  }

  const payload = `${userId}.${target}.${targetId}`;

  return `${payload}.${sign(payload)}`;
}

export function parseWatchToken(token: string) {
  const m =
    /^(\d+)\.(event|picture|wikimedia)\.([\w-]{1,16})\.([\w-]{22})$/.exec(
      token,
    );

  if (!m || !secret()) {
    return null;
  }

  const expected = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`));

  const given = Buffer.from(m[4]!);

  if (!timingSafeEqual(expected, given)) {
    return null;
  }

  return {
    userId: Number(m[1]),
    target: m[2] as MailTarget,
    targetId: m[3]!,
  };
}
