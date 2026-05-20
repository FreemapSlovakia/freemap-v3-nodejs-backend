import { randomBytes } from 'node:crypto';
import { ParameterizedContext } from 'koa';
import sql, { empty, join, RawValue, raw } from 'sql-template-tag';
import z from 'zod';
import { authProviderToColumn, rowToUser } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { fetchAndProcessProfilePicture } from '../../profilePicture.js';
import {
  LoginResponseSchema,
  USER_COLUMNS_SQL,
  UserRowSchema,
} from '../../types.js';

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

  const { userRow, authToken } = await runInTransaction(async (conn) => {
    await conn.beginTransaction();

    const [userRow] = await conn.query<unknown[]>(
      sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE ${raw(authProviderToColumn[authProvider])} = ${remoteUserId} FOR UPDATE`,
    );

    let user = userRow ? UserRowSchema.parse(userRow) : undefined;
    let matchedByEmail = false;

    // First-time login from this provider: if a user with the same email
    // already exists, link the provider to that account instead of creating
    // a new one. Only link when the match is unambiguous and the existing
    // user has no account on this provider yet.
    if (!user && !currentUser && remoteEmail) {
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

    userId = (currentUser ?? user ?? {}).id;

    const now = new Date();

    if (user) {
      const cols = [
        'garminUserId',
        'garminAccessToken',
        'garminAccessTokenSecret',
        'osmId',
        'facebookUserId',
        'googleUserId',
        'appleUserId',
      ] as const;

      // found user in DB for this auth provider

      const authData: Partial<
        Record<(typeof cols)[number], string | number | null>
      > = {};

      for (const col of cols) {
        authData[col] = user[col];
      }

      if (currentUser) {
        if (currentUser[authProviderToColumn[authProvider]]) {
          ctx.throw(400, 'provider already set');
        }

        for (const col of [
          'garminUserId',
          'osmId',
          'facebookUserId',
          'googleUserId',
          'appleUserId',
        ] as const) {
          if (currentUser[col] && user[col] && currentUser[col] !== user[col]) {
            ctx.throw(400, 'conflicting providers');
          }
        }

        Object.assign(authData, {
          [authProviderToColumn[authProvider]]: remoteUserId,
          ...extraUserFields,
        });

        const {
          id,
          email,
          coordinates,
          language,
          createdAt,
          isAdmin,
          sendGalleryEmails,
          settings,
          premiumExpiration,
          credits,
        } = user;

        await conn.query<unknown>(sql`DELETE FROM auth WHERE userId = ${id}`);

        await Promise.all([
          ...[
            'picture',
            'pictureComment',
            'pictureRating', // TODO may conflict
            'trackingDevice',
            'map',
            'mapWriteAccess', // TODO may conflict
            'purchase',
            'purchaseToken',
          ].map((table) =>
            conn.query<unknown>(
              sql`UPDATE ${raw(table)} SET userId = ${currentUser.id} WHERE userId = ${id}`,
            ),
          ),
        ]);

        await conn.query<unknown>(sql`DELETE FROM user WHERE id = ${id}`);

        // TODO merge settings
        // TODO sum purchase expirations

        const query = sql`UPDATE user SET
          email = COALESCE(email, ${email}),
          lat = COALESCE(lat, ${coordinates?.lat}),
          lon = COALESCE(lon, ${coordinates?.lon}),
          language = COALESCE(language, ${language}),
          createdAt = LEAST(createdAt, ${createdAt}),
          isAdmin = isAdmin OR ${isAdmin},
          ${premiumExpiration ? sql`premiumExpiration = COALESCE(GREATEST(premiumExpiration, ${premiumExpiration}), ${premiumExpiration}),` : empty}
          sendGalleryEmails = sendGalleryEmails OR ${sendGalleryEmails},
          settings = COALESCE(settings, ${settings}),
          credits = credits + ${credits},
          picture = COALESCE(picture, ${newPicture}),
          ${join(
            Object.entries(authData).map(
              ([column, value]) =>
                sql`${raw(column)} = COALESCE(${raw(column)}, ${value})`,
            ),
          )}
          WHERE id = ${currentUser.id}
        `;

        await conn.query<unknown>(query);
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

      if (currentUser) {
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

          WHERE id = ${currentUser.id}
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
                isAdmin: false,
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

    return { userRow: UserRowSchema.parse(row), authToken };
  });

  ctx.body = LoginResponseSchema.parse({
    user: rowToUser(userRow, authToken),
    connect,
    clientData,
  });
}
