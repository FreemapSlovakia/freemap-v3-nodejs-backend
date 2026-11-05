import { randomBytes } from 'node:crypto';
import type { ParameterizedContext } from 'koa';
import type { PoolConnection } from 'mariadb';
import sql, { join, type RawValue, raw } from 'sql-template-tag';
import z from 'zod';
import { authProviderToColumn, rowToUser } from '../../authenticator.js';
import {
  isVerifiedEmailTaken,
  pool,
  runInTransaction,
} from '../../database.js';
import {
  emailChangeSql,
  emailFieldsSql,
  NO_EMAIL,
  nextEmail,
  normalizeEmail,
} from '../../emailAddress.js';
import { pickLanguage } from '../../mailer.js';
import { NEW_USER_NAMES } from '../../newUserNames.js';
import { fetchAndProcessProfilePicture } from '../../profilePicture.js';
import {
  LoginResponseSchema,
  USER_COLUMNS_SQL,
  type UserRow,
  UserRowSchema,
} from '../../types.js';
import {
  MergeConflictError,
  mergeUserAccounts,
  olderFirst,
} from '../../userMerge.js';

// Their addresses are verified by the provider. Not Microsoft (an Entra tenant
// can set any `mail` it likes), nor Facebook (no promise its `email` is
// confirmed).
const EMAIL_PROVING_PROVIDERS = new Set<keyof typeof authProviderToColumn>([
  'google',
  'apple',
  'github',
]);

/** For a transaction that may verify an address another one verifies too. */
export const VERIFIED_EMAIL_RETRY = { retryOn: isVerifiedEmailTaken };

/** The account with this address proven (at most one is), but `exceptId`. */
export async function findByVerifiedEmail(
  conn: PoolConnection,
  emailKey: string | null,
  exceptId = 0,
): Promise<UserRow | undefined> {
  const [row] = await conn.query<unknown[]>(
    sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user
      WHERE verifiedEmailKey = ${emailKey} AND id <> ${exceptId} FOR UPDATE`,
  );

  return row ? UserRowSchema.parse(row) : undefined;
}

async function insertUser(
  conn: PoolConnection,
  fields: Record<string, unknown>,
): Promise<number> {
  return (
    await conn.query<{ insertId: number }>(
      sql`INSERT INTO user SET ${join(
        Object.entries({
          sendGalleryEmails: true,
          credits: 100,
          ...fields,
        }).map(([column, value]) => sql`${raw(column)} = ${value}`),
      )}`,
    )
  ).insertId;
}

export async function startSession(
  conn: PoolConnection,
  userId: number,
  now: Date,
): Promise<string> {
  const authToken = randomBytes(32).toString('base64');

  await conn.query<unknown>(
    sql`INSERT INTO auth SET userId = ${userId}, createdAt = ${now}, authToken = ${authToken}`,
  );

  return authToken;
}

/**
 * Logs into the account with this address proven, creating one if none has.
 * The caller has checked the code sent there.
 */
export async function loginWithEmail(
  ctx: ParameterizedContext,
  email: string,
  language: string | null,
  /** As the request's `settings` parsed by `LoginSettingsSchema`. */
  settings: z.infer<typeof LoginSettingsSchema> = {},
) {
  const fields = nextEmail(NO_EMAIL, email, { proven: true });

  // As the code email was written in.
  const nameLanguage = pickLanguage(ctx, language, NEW_USER_NAMES);

  // Two at once may both insert; the second fails on the unique verified
  // address, and its retry finds the first's account.
  const { userRow, authToken } = await runInTransaction(async (conn) => {
    const user = await findByVerifiedEmail(conn, fields.emailKey);

    const now = new Date();

    // What it lacks, as a provider login fills it in.
    if (user) {
      await conn.query<unknown>(
        sql`UPDATE user SET
          language = COALESCE(language, ${language}),
          lat = COALESCE(lat, ${settings.lat ?? null}),
          lon = COALESCE(lon, ${settings.lon ?? null})
        WHERE id = ${user.id}`,
      );
    }

    const userId =
      user?.id ??
      (await insertUser(conn, {
        name: NEW_USER_NAMES[nameLanguage],
        ...fields,
        language,
        createdAt: now,
        lat: settings.lat ?? null,
        lon: settings.lon ?? null,
        settings: JSON.stringify(settings),
      }));

    const authToken = await startSession(conn, userId, now);

    const [row] = await conn.query<unknown[]>(
      sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${userId}`,
    );

    return { userRow: UserRowSchema.parse(row), authToken };
  }, VERIFIED_EMAIL_RETRY);

  ctx.body = LoginResponseSchema.parse({
    user: rowToUser(userRow, authToken),
    connect: false,
    clientData: undefined,
  });
}

/** A login's `settings`: the new account's home location. */
export const LoginSettingsSchema = z.object({
  lat: z.number().nullish(),
  lon: z.number().nullish(),
});

const SettingsBodySchema = z.object({
  settings: LoginSettingsSchema.optional(),
});

export async function login(
  ctx: ParameterizedContext,
  authProvider: keyof typeof authProviderToColumn,
  remoteUserId: string | number,
  remoteName: string | undefined,
  remoteEmail: string | null | undefined,
  remoteLat: number | undefined,
  remoteLon: number | undefined,
  remoteLanguage: string | null,
  connect = false,
  {
    extraUserFields = {},
    clientData,
    remotePictureUrl,
    onCommitted,
    remoteEmailVerified = false,
  }: {
    extraUserFields?: Record<string, unknown>;
    clientData?: unknown;
    remotePictureUrl?: string | null;
    /**
     * Called once the login has committed, with the rows it locked as they
     * were before it wrote them, e.g. to revoke the provider tokens it replaced.
     */
    onCommitted?: (previousRows: UserRow[]) => void;
    /** The provider vouches for `remoteEmail`; unset, it proves nothing. */
    remoteEmailVerified?: boolean;
  } = {},
) {
  const currentUser = connect ? ctx.state.user : undefined;

  if (connect && !currentUser) {
    connect = false; // let just log in

    // ctx.throw(403, 'unauthenticated');
  }

  // Fetch and process the provider's picture before opening the transaction
  // (to avoid holding row locks during HTTP). Skip the fetch when the
  // provider-matched user already has a picture stored — pictures are never
  // overwritten anyway, so the download would be discarded.
  let newPicture: Buffer | null = null;

  if (remotePictureUrl) {
    const existingRows = await pool.query<{ hasPicture: number | bigint }[]>(
      sql`SELECT picture IS NOT NULL AS hasPicture FROM user
          WHERE ${raw(authProviderToColumn[authProvider])} = ${remoteUserId}`,
    );

    const alreadyHasPicture =
      existingRows.length > 0 && Boolean(Number(existingRows[0].hasPicture));

    if (!alreadyHasPicture) {
      newPicture = await fetchAndProcessProfilePicture(remotePictureUrl);
    }
  }

  let userId;

  const { userRow, authToken, previousRows } = await runInTransaction(
    async (conn) => {
      const email = remoteEmail || null;

      const emailKey = email ? normalizeEmail(email) : null;

      const emailProven =
        emailKey !== null &&
        remoteEmailVerified &&
        EMAIL_PROVING_PROVIDERS.has(authProvider);

      // The account being connected to, read under the lock: what the session
      // read before the transaction may be stale by now.
      let current: UserRow | undefined;

      if (currentUser) {
        const [row] = await conn.query<unknown[]>(
          sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${currentUser.id} FOR UPDATE`,
        );

        if (!row) {
          ctx.throw(401, 'account gone');
        }

        current = UserRowSchema.parse(row);

        // Connecting a provider the account already has only re-authorizes it,
        // and only as the same remote user; another one would replace the link.
        const linkedRemoteId = current[authProviderToColumn[authProvider]];

        if (
          linkedRemoteId != null &&
          String(linkedRemoteId) !== String(remoteUserId)
        ) {
          ctx.throw(409, 'different provider account');
        }
      }

      const [userRow] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE ${raw(authProviderToColumn[authProvider])} = ${remoteUserId} FOR UPDATE`,
      );

      let user = userRow ? UserRowSchema.parse(userRow) : undefined;
      let matchedByEmail = false;

      // Proven, and on no other account, which holds it uniquely. A concurrent
      // proof elsewhere fails on the unique index, and the retry sees it.
      const provenFor = async (id: number | undefined) =>
        emailProven && !(await findByVerifiedEmail(conn, emailKey, id));

      // SQL applying the provider's address to `row`: stored where none is, a
      // proof added to the same mailbox, or — proven — replacing an unproven
      // one, as a merge does. One its owner removed isn't brought back.
      const emailAfterSql = async (row: UserRow) => {
        if (row.email === null && row.emailReminderOff) {
          return emailFieldsSql(row);
        }

        const proven = await provenFor(row.id);

        const next = nextEmail(row, email, {
          proven,
          keepExisting: !(proven && !row.emailVerified),
        });

        return emailChangeSql(row, next);
      };

      // The account the address is proven on, when it's not this login's.
      let candidate: UserRow | undefined;

      // A proven address finds the account it is proven on, as email login does.
      if (!user && !current && emailProven) {
        candidate = await findByVerifiedEmail(conn, emailKey);

        if (candidate && !candidate[authProviderToColumn[authProvider]]) {
          user = candidate;
          matchedByEmail = true;
        }
      }

      userId = (current ?? user)?.id;

      // As read, before anything below writes them; once when they are the same
      // account (a re-authorization).
      const previousRows = [
        current,
        user?.id === current?.id ? undefined : user,
      ].filter((row) => row !== undefined);

      const now = new Date();

      if (user) {
        // found user in DB for this auth provider

        // Connecting the provider the account already has re-authorizes it (e.g.
        // for a wider OSM scope), so only its extra fields are updated below.
        if (current && current.id !== user.id) {
          // The older account stays, even when it isn't the logged-in one;
          // the session then moves to it, below.
          const [target, source] = olderFirst(current, user);

          userId = target.id;

          try {
            await mergeUserAccounts(conn, target, source, {
              extraTargetFields: {
                [authProviderToColumn[authProvider]]: remoteUserId,
                ...extraUserFields,
              },
              newPicture,
            });
          } catch (err) {
            if (err instanceof MergeConflictError) {
              ctx.throw(400, 'conflicting providers');
            }

            throw err;
          }

          // The provider may vouch for the address the merged account has.
          const [merged] = await conn.query<unknown[]>(
            sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${target.id} FOR UPDATE`,
          );

          await conn.query<unknown>(
            sql`UPDATE user SET ${await emailAfterSql(UserRowSchema.parse(merged))} WHERE id = ${target.id}`,
          );
        } else if (matchedByEmail) {
          await conn.query<unknown>(sql`UPDATE user SET
          language = COALESCE(language, ${remoteLanguage}),
          lat = COALESCE(lat, ${remoteLat ?? null}),
          lon = COALESCE(lon, ${remoteLon ?? null}),
          picture = COALESCE(picture, ${newPicture}),
          ${join(
            Object.entries({
              [authProviderToColumn[authProvider]]: remoteUserId,
              ...extraUserFields,
            }).map(([column, value]) => sql`${raw(column)} = ${value}`),
          )}
          WHERE id = ${user.id}
        `);
        } else {
          const setExprs: RawValue[] = [];

          if (newPicture && !user.hasPicture) {
            setExprs.push(sql`picture = ${newPicture}`);
          }

          for (const [column, value] of Object.entries(extraUserFields)) {
            setExprs.push(sql`${raw(column)} = ${value}`);
          }

          setExprs.push(await emailAfterSql(user));

          if (setExprs.length > 0) {
            await conn.query<unknown>(
              sql`UPDATE user SET ${join(setExprs)} WHERE id = ${user.id}`,
            );
          }
        }
      } else {
        // no such user in DB for this auth provider

        let body;

        try {
          body = SettingsBodySchema.parse(ctx.request.body);
        } catch (err) {
          ctx.log.warn({ body }, 'Invalid body.');

          return ctx.throw(400, err as Error);
        }

        const settings = body.settings ?? {};
        const lat = remoteLat ?? settings.lat ?? null;
        const lon = remoteLon ?? settings.lon ?? null;

        if (current) {
          await conn.query<unknown>(sql`UPDATE user SET
          ${await emailAfterSql(current)},
          language = COALESCE(language, ${remoteLanguage}),
          lat = COALESCE(lat, ${lat}),
          lon = COALESCE(lon, ${lon}),
          picture = COALESCE(picture, ${newPicture}),
          ${join(
            Object.entries({
              [authProviderToColumn[authProvider]]: remoteUserId,
              ...extraUserFields,
            }).map(([column, value]) => sql`${raw(column)} = ${value}`),
          )}

          WHERE id = ${current.id}
        `);
        } else {
          userId = await insertUser(conn, {
            name:
              remoteName ||
              NEW_USER_NAMES[pickLanguage(ctx, remoteLanguage, NEW_USER_NAMES)],
            // Only reached when the lookup above found none to log into.
            ...nextEmail(NO_EMAIL, email, {
              proven: emailProven && !candidate,
            }),
            language: remoteLanguage,
            createdAt: now,
            lat: lat ?? null,
            lon: lon ?? null,
            settings: JSON.stringify(settings),
            picture: newPicture,
            [authProviderToColumn[authProvider]]: remoteUserId,
            ...extraUserFields,
          });
        }
      }

      let authToken;

      // A fresh one also when a connect merged the logged-in account into an
      // older one: the merge deleted its sessions.
      if (currentUser && userId === currentUser.id) {
        authToken = currentUser.authToken;
      } else {
        authToken = await startSession(conn, userId!, now);
      }

      const [row] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${userId}`,
      );

      return { userRow: UserRowSchema.parse(row), authToken, previousRows };
    },
    VERIFIED_EMAIL_RETRY,
  );

  onCommitted?.(previousRows);

  ctx.body = LoginResponseSchema.parse({
    user: rowToUser(userRow, authToken),
    connect,
    clientData,
  });
}
