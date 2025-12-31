import { ParameterizedContext } from 'koa';
import { randomBytes } from 'node:crypto';
import sql, { RawValue, empty, join, raw } from 'sql-template-tag';
import {
  authProviderToColumn,
  rowToUser,
  userForResponse,
  UserRow,
} from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { assert } from 'typia';

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
) {
  const currentUser = connect ? ctx.state.user : undefined;

  if (connect && !currentUser) {
    connect = false; // let just log in

    // ctx.throw(403, 'unauthenticated');
  }

  let userId;

  const { userRow, authToken } = await runInTransaction(async (conn) => {
    await conn.beginTransaction();

    const [userRow] = await conn.query(
      sql`SELECT * FROM user WHERE ${raw(authProviderToColumn[authProvider])} = ${remoteUserId} FOR UPDATE`,
    );

    userId = (currentUser ?? userRow ?? {}).id;

    const now = new Date();

    if (userRow) {
      // found user in DB for this auth provider

      const authData: Record<string, string> = {};

      for (const col of [
        'garminUserId',
        'garminAccessToken',
        'garminAccessTokenSecret',
        'osmId',
        'facebookUserId',
        'googleUserId',
      ]) {
        authData[col] = userRow[col];
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
        ] as const) {
          if (
            currentUser[col] &&
            userRow[col] &&
            currentUser[col] !== userRow[col]
          ) {
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
          lat,
          lon,
          language,
          createdAt,
          isAdmin,
          sendGalleryEmails,
          settings,
          premiumExpiration,
          credits,
        } = userRow;

        await conn.query(sql`DELETE FROM auth WHERE userId = ${id}`);

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
            conn.query(
              sql`UPDATE ${raw(table)} SET userId = ${currentUser.id} WHERE userId = ${id}`,
            ),
          ),
        ]);

        await conn.query(sql`DELETE FROM user WHERE id = ${id}`);

        // TODO merge settings
        // TODO sum purchase expirations

        const query = sql`UPDATE user SET
        email = COALESCE(email, ${email}),
        lat = COALESCE(lat, ${lat}),
        lon = COALESCE(lon, ${lon}),
        language = COALESCE(language, ${language}),
        createdAt = LEAST(createdAt, ${createdAt}),
        isAdmin = isAdmin OR ${isAdmin},
        ${premiumExpiration ? sql`premiumExpiration = COALESCE(GREATEST(premiumExpiration, ${premiumExpiration}), ${premiumExpiration}),` : empty}
        sendGalleryEmails = sendGalleryEmails OR ${sendGalleryEmails},
        settings = COALESCE(settings, ${settings}),
        credits = credits + ${credits},
        ${join(
          Object.entries(authData).map(
            ([column, value]) =>
              sql`${raw(column)} = COALESCE(${raw(column)}, ${value as RawValue})`,
          ),
        )}
        WHERE id = ${currentUser.id}
      `;

        await conn.query(query);
      } else {
        if (Object.keys(extraUserFields).length > 0) {
          await conn.query(sql`UPDATE user SET
          ${join(
            Object.entries(extraUserFields).map(
              ([column, value]) => sql`${raw(column)} = ${value as RawValue}`,
            ),
          )}
          WHERE id = ${userRow.id}
        `);
        }
      }
    } else {
      // no such user in DB for this auth provider

      const settings = (ctx.request.body as any).settings || {};
      const lat = remoteLat ?? settings.lat ?? null;
      const lon = remoteLon ?? settings.lon ?? null;
      const email = remoteEmail || null;

      if (currentUser) {
        await conn.query(sql`UPDATE user SET
        email = COALESCE(email, ${email}),
        language = COALESCE(language, ${remoteLanguage}),
        lat = COALESCE(lat, ${lat}),
        lon = COALESCE(lon, ${lon}),
        ${join(
          Object.entries({
            [authProviderToColumn[authProvider]]: remoteUserId,
            ...extraUserFields,
          }).map(
            ([column, value]) => sql`${raw(column)} = ${value as RawValue}`,
          ),
        )}

        WHERE id = ${currentUser.id}
    `);
      } else {
        userId = (
          await conn.query(
            sql`INSERT INTO user SET ${join(
              Object.entries({
                name: remoteName,
                email,
                language: remoteLanguage,
                createdAt: now,
                lat: lat ?? null,
                lon: lon ?? null,
                sendGalleryEmails: true,
                isAdmin: false,
                settings: JSON.stringify(settings),
                [authProviderToColumn[authProvider]]: remoteUserId,
                ...extraUserFields,
              }).map(
                ([column, value]) => sql`${raw(column)} = ${value as RawValue}`,
              ),
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

      await conn.query(
        sql`INSERT INTO auth SET userId = ${userId}, createdAt = ${now}, authToken = ${authToken}`,
      );
    }

    const [row] = await conn.query(
      sql`SELECT * FROM user WHERE id = ${userId}`,
    );

    return { userRow: assert<UserRow>(row), authToken };
  });

  ctx.body = {
    user: userForResponse(rowToUser(userRow, authToken)),
    connect,
    clientData,
  };
}
