import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import type { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool, runInTransaction } from './database.js';
import { normalizeEmail } from './emailAddress.js';
import {
  CODE_TTL_MINUTES,
  codeHtml,
  type EmailCodeNote,
  type EmailCodePurpose,
  emailCodeTranslations as translations,
} from './emailCodeTexts.js';
import { getEnvBoolean } from './env.js';
import { pickLanguage, sendMail } from './mailer.js';
import { esc, htmlPage, htmlPara, htmlSmall } from './mailHtml.js';

export type { EmailCodeNote, EmailCodePurpose };

const MAX_ATTEMPTS = 5;

const MIN_RESEND_SECONDS = 60;

const MAX_PER_ADDRESS_PER_HOUR = 5;

const MAX_PER_IP_PER_HOUR = 20;

// Comparisons against an address's codes, all of them: 20 a day keep a 6-digit
// code's yearly odds of being guessed under 1%.
const MAX_GUESSES_PER_ADDRESS_PER_DAY = 20;

const HOUR_MS = 3_600_000;

const DAY_MS = 24 * HOUR_MS;

// In memory: the API runs as one process, and a restart only resets the caps.
const sendsByIp = new Map<string, number[]>();

const guessesByAddress = new Map<string, number[]>();

// Else every IP and address that ever asked stays in memory.
setInterval(() => {
  const now = Date.now();

  for (const [map, window] of [
    [sendsByIp, HOUR_MS],
    [guessesByAddress, DAY_MS],
  ] as const) {
    for (const [key, times] of map) {
      if (times.every((t) => t <= now - window)) {
        map.delete(key);
      }
    }
  }
}, 600_000).unref();

/**
 * Records one occurrence under `key` unless `max` happened within `window`,
 * returning what gives it back. Synchronous, so parallel requests can't all
 * pass between check and count.
 */
function takeSlot(
  map: Map<string, number[]>,
  key: string,
  max: number,
  window: number,
): (() => void) | undefined {
  const now = Date.now();

  const recent = (map.get(key) ?? []).filter((t) => t > now - window);

  if (recent.length >= max) {
    return undefined;
  }

  recent.push(now);

  map.set(key, recent);

  return () => {
    const times = map.get(key);

    const index = times?.indexOf(now) ?? -1;

    if (index >= 0) {
      times!.splice(index, 1);
    }
  };
}

// Keyed, and never stored: a plain hash of a 6-digit code is reversed from a
// table of a million. A restart voids live codes, which last minutes anyway.
const CODE_KEY = randomBytes(32);

function hashCode(code: string) {
  return createHmac('sha256', CODE_KEY).update(code).digest();
}

function clientIp(ctx: ParameterizedContext) {
  // Set by nginx from the peer address; the API listens on loopback only.
  return ctx.get('x-real-ip') || ctx.ip;
}

/** Sends a fresh code to `email`; throws 429 past the send limits. */
export async function sendEmailCode(
  ctx: ParameterizedContext,
  purpose: EmailCodePurpose,
  email: string,
  language: string | null | undefined,
  userId: number | null = null,
  /** Asked only once the limits let the code go out. */
  note?: () => Promise<EmailCodeNote | undefined>,
) {
  const emailKey = normalizeEmail(email);

  // Given back on any failure: nothing went out, so a retry mustn't use up
  // the IP.
  const releaseIpSlot = takeSlot(
    sendsByIp,
    clientIp(ctx),
    MAX_PER_IP_PER_HOUR,
    HOUR_MS,
  );

  if (!releaseIpSlot) {
    ctx.throw(429, 'too many codes');
  }

  try {
    await storeAndSend(ctx, purpose, email, emailKey, language, userId, note);
  } catch (err) {
    releaseIpSlot();

    throw err;
  }
}

async function storeAndSend(
  ctx: ParameterizedContext,
  purpose: EmailCodePurpose,
  email: string,
  emailKey: string,
  language: string | null | undefined,
  userId: number | null,
  noteOf: (() => Promise<EmailCodeNote | undefined>) | undefined,
) {
  const code = String(randomInt(1_000_000)).padStart(6, '0');

  // Inserted before counting, so parallel requests see each other's rows; on
  // a race every one of them may refuse, never all pass.
  const { insertId } = await pool.query<{ insertId: number }>(
    sql`INSERT INTO emailCode SET
      purpose = ${purpose},
      userId = ${userId},
      email = ${email},
      emailKey = ${emailKey},
      codeHash = ${hashCode(code)},
      requestIp = ${clientIp(ctx)},
      expireAt = NOW() + INTERVAL ${CODE_TTL_MINUTES} MINUTE`,
  );

  // Compared in SQL, against the clock createdAt was stamped with. The gap is
  // between resends of one purpose: a login right after a confirmation is fine.
  const [{ count, recent }] = z
    .array(z.object({ count: z.number(), recent: z.coerce.boolean() }))
    .parse(
      await pool.query<unknown[]>(
        sql`SELECT COUNT(*) AS count,
            COALESCE(MAX(purpose = ${purpose} AND createdAt > NOW() - INTERVAL ${MIN_RESEND_SECONDS} SECOND), 0) AS recent
          FROM emailCode
          WHERE emailKey = ${emailKey} AND id <> ${insertId}
            AND createdAt > NOW() - INTERVAL 1 HOUR`,
      ),
    );

  if (count >= MAX_PER_ADDRESS_PER_HOUR || recent) {
    await pool.query<unknown>(
      sql`DELETE FROM emailCode WHERE id = ${insertId}`,
    );

    ctx.throw(429, 'too many codes');
  }

  const t = translations[pickLanguage(ctx, language, translations)]!;

  let note: EmailCodeNote | undefined;

  // Advice only: without it the code still goes out.
  try {
    note = await noteOf?.();
  } catch (err) {
    ctx.log.warn({ err }, 'email code note lookup failed');
  }

  if (getEnvBoolean('MAILGUN_ENABLE', false)) {
    try {
      await sendMail(
        email,
        t.subject[purpose],
        [t.code(code), note && t.notes[note], t.ignore]
          .filter(Boolean)
          .join('\n\n'),
        {
          html: htmlPage([
            htmlPara(codeHtml(t, code)),
            ...(note ? [htmlPara(esc(t.notes[note]))] : []),
            htmlSmall(esc(t.ignore)),
          ]),
        },
      );
    } catch (err) {
      // An undelivered code must not hold up the retry.
      await pool.query<unknown>(
        sql`DELETE FROM emailCode WHERE id = ${insertId}`,
      );

      throw err;
    }
  } else {
    ctx.log.warn(
      { email, code, note },
      'MAILGUN_ENABLE is off — not mailing the code',
    );
  }

  // Once it's out: the requester's own resend leaves one live code, so a
  // guess costs one try. Another requester's codes stay, not to void theirs.
  await pool.query<unknown>(
    sql`UPDATE emailCode SET expireAt = NOW()
      WHERE emailKey = ${emailKey} AND purpose = ${purpose} AND userId <=> ${userId}
        AND requestIp = ${clientIp(ctx)} AND id <> ${insertId} AND expireAt > NOW()`,
  );
}

/**
 * Spends `code` if it is one of the live codes sent to `email` for this
 * purpose (and user) — any of them, so a code someone else requests doesn't
 * void the owner's; else throws 403, or 429 past the daily guess cap. A guess
 * counts against every live code and that cap.
 */
export async function checkEmailCode(
  ctx: ParameterizedContext,
  purpose: EmailCodePurpose,
  email: string,
  code: string,
  userId: number | null = null,
): Promise<void> {
  const emailKey = normalizeEmail(email);

  // Not 403: the code may well be right, and the user should be told to wait.
  const takeGuess = () => {
    if (
      !takeSlot(
        guessesByAddress,
        emailKey,
        MAX_GUESSES_PER_ADDRESS_PER_DAY,
        DAY_MS,
      )
    ) {
      ctx.throw(429, 'too many attempts');
    }
  };

  takeGuess();

  const live = sql`emailKey = ${emailKey} AND purpose = ${purpose}
    AND userId <=> ${userId} AND expireAt > NOW() AND attempts < ${MAX_ATTEMPTS}`;

  // Read and counted under the lock, so parallel guesses can't all pass the
  // per-code limit; committed before comparing, so a wrong guess counts.
  const rows = await runInTransaction(async (conn) => {
    const locked = z
      .array(z.object({ id: z.uint32(), codeHash: z.instanceof(Buffer) }))
      .parse(
        await conn.query<unknown[]>(
          sql`SELECT id, codeHash FROM emailCode WHERE ${live} FOR UPDATE`,
        ),
      );

    await conn.query<unknown>(
      sql`UPDATE emailCode SET attempts = attempts + 1 WHERE ${live}`,
    );

    return locked;
  });

  // A guess against several live codes is that many tries at the cap: one was
  // taken above, before the first await, the rest here, outside the retried
  // transaction so a retry doesn't count them again.
  for (let i = 1; i < rows.length; i++) {
    takeGuess();
  }

  const hash = hashCode(code);

  const matchId = rows.find((row) => timingSafeEqual(hash, row.codeHash))?.id;

  if (matchId === undefined) {
    ctx.throw(403, 'invalid code');
  }

  // Conditional, so of concurrent correct submissions only one passes.
  const { affectedRows } = await pool.query<{ affectedRows: number }>(
    sql`UPDATE emailCode SET expireAt = NOW() WHERE id = ${matchId} AND expireAt > NOW()`,
  );

  if (affectedRows !== 1) {
    ctx.throw(403, 'invalid code');
  }

  await pool.query<unknown>(
    sql`UPDATE emailCode SET expireAt = NOW()
      WHERE emailKey = ${emailKey} AND purpose = ${purpose} AND userId <=> ${userId} AND expireAt > NOW()`,
  );
}
