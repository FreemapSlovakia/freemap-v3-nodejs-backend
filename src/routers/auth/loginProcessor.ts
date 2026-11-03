import { randomBytes } from 'node:crypto';
import type { ParameterizedContext } from 'koa';
import sql, { join, type RawValue, raw } from 'sql-template-tag';
import z from 'zod';
import { authProviderToColumn, rowToUser } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { getEnvBoolean } from '../../env.js';
import { fetchAndProcessProfilePicture } from '../../profilePicture.js';
import {
  LoginResponseSchema,
  USER_COLUMNS_SQL,
  type UserRow,
  UserRowSchema,
} from '../../types.js';
import { MergeConflictError, mergeUserAccounts } from '../../userMerge.js';

// Auto-link a new provider sign-in to an existing account when the emails
// match. Unsafe in general (we don't verify stored emails), so off by
// default. Same env flag also enables the startup bulk dedup.
const LINK_USER_ACCOUNTS_BY_NAME_AND_EMAIL_ON_STARTUP = getEnvBoolean(
  'LINK_USER_ACCOUNTS_BY_NAME_AND_EMAIL_ON_STARTUP',
  false,
);

const SettingsBodySchema = z.object({
  settings: z
    .object({
      lat: z.number().nullish(),
      lon: z.number().nullish(),
    })
    .optional(),
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
  extraUserFields: Record<string, unknown> = {},
  clientData?: unknown,
  remotePictureUrl?: string | null,
  /**
   * Called once the login has committed, with the rows it locked as they were
   * before it wrote them, e.g. to revoke the provider tokens it replaced.
   */
  onCommitted?: (previousRows: UserRow[]) => void,
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

      if (
        LINK_USER_ACCOUNTS_BY_NAME_AND_EMAIL_ON_STARTUP &&
        !user &&
        !current &&
        remoteEmail
      ) {
        const emailUserRows = await conn.query<unknown[]>(
          sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE email = ${remoteEmail} FOR UPDATE`,
        );

        if (emailUserRows.length === 1) {
          const candidate = UserRowSchema.parse(emailUserRows[0]);

          if (!candidate[authProviderToColumn[authProvider]]) {
            user = candidate;
            matchedByEmail = true;
          }
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
          try {
            await mergeUserAccounts(conn, current, user, {
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
        const email = remoteEmail || null;

        if (current) {
          await conn.query<unknown>(sql`UPDATE user SET
          email = COALESCE(email, ${email}),
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
          userId = (
            await conn.query<{ insertId: number }>(
              sql`INSERT INTO user SET ${join(
                Object.entries({
                  name: remoteName || email?.split('@')[0] || 'Apple User',
                  email,
                  language: remoteLanguage,
                  createdAt: now,
                  lat: lat ?? null,
                  lon: lon ?? null,
                  sendGalleryEmails: true,
                  settings: JSON.stringify(settings),
                  credits: 100,
                  picture: newPicture,
                  [authProviderToColumn[authProvider]]: remoteUserId,
                  ...extraUserFields,
                }).map(([column, value]) => sql`${raw(column)} = ${value}`),
              )}`,
            )
          ).insertId;
        }
      }

      let authToken;

      if (currentUser) {
        authToken = currentUser.authToken;
      } else {
        authToken = randomBytes(32).toString('base64');

        await conn.query<unknown>(
          sql`INSERT INTO auth SET userId = ${userId}, createdAt = ${now}, authToken = ${authToken}`,
        );
      }

      const [row] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${userId}`,
      );

      return { userRow: UserRowSchema.parse(row), authToken, previousRows };
    },
  );

  onCommitted?.(previousRows);

  ctx.body = LoginResponseSchema.parse({
    user: rowToUser(userRow, authToken),
    connect,
    clientData,
  });
}
