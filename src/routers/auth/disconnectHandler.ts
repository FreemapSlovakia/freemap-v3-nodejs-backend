import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { revokeOsmTokenLater } from '../../osm.js';
import {
  PROVIDER_ID_COLUMNS,
  USER_COLUMNS_SQL,
  UserRowSchema,
} from '../../types.js';

export function attachDisconnectHandler(router: RouterInstance) {
  registerPath('/auth/providers/{provider}', {
    delete: {
      summary: 'Disconnect a linked auth provider',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          provider: z.enum([
            'osm',
            'facebook',
            'google',
            'garmin',
            'apple',
            'github',
            'strava',
            'microsoft',
          ]),
        }),
      },
      responses: {
        204: {},
        400: {},
        401: {},
        409: { description: 'The last login provider of the account' },
      },
    },
  });

  router.delete('/providers/:provider', authenticator(true), async (ctx) => {
    const providerColumns: Record<string, string[]> = {
      osm: ['osmId', 'osmAccessToken'],
      facebook: ['facebookUserId'],
      google: ['googleUserId'],
      garmin: ['garminUserId', 'garminAccessToken', 'garminAccessTokenSecret'],
      apple: ['appleUserId'],
      github: ['githubUserId'],
      strava: [
        'stravaUserId',
        'stravaAccessToken',
        'stravaRefreshToken',
        'stravaTokenExpiresAt',
      ],
      microsoft: ['microsoftUserId'],
    };

    const columns = Object.hasOwn(providerColumns, ctx.params.provider)
      ? providerColumns[ctx.params.provider]
      : undefined;

    if (!columns) {
      return ctx.throw(400, 'unknown provider');
    }

    const userId = ctx.state.user!.id;

    // Read under the lock: the token in the row now, not the one read when the
    // request started, and the providers left after a concurrent disconnect.
    const osmToken = await runInTransaction(async (conn) => {
      const [rawRow] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${userId} FOR UPDATE`,
      );

      if (!rawRow) {
        return ctx.throw(401, 'account gone');
      }

      const row = UserRowSchema.parse(rawRow);

      // Without a provider left, nobody could log in to the account again.
      if (
        !PROVIDER_ID_COLUMNS.some(
          (column) => !columns.includes(column) && row[column] != null,
        )
      ) {
        return ctx.throw(409, 'last provider');
      }

      await conn.query<unknown>(
        sql`UPDATE user SET ${join(
          columns.map((col) => sql`${raw(col)} = NULL`),
          ',',
        )} WHERE id = ${userId}`,
      );

      return ctx.params.provider === 'osm' ? row.osmAccessToken : null;
    });

    if (osmToken) {
      revokeOsmTokenLater(osmToken, ctx.log);
    }

    ctx.status = 204;
  });
}
