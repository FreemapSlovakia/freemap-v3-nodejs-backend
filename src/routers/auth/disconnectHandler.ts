import { pool } from '../../database';
import Router from '@koa/router';
import { authenticator } from '../../authenticator';
import sql, { join, raw } from 'sql-template-tag';
import { randomBytes } from 'crypto';

export function attachDisconnectHandler(router: Router) {
  router.delete('/providers/:provider', authenticator(true), async (ctx) => {
    const providerColumns: Record<string, string[]> = {
      osm: ['osmId'],
      facebook: ['facebookUserId'],
      google: ['googleUserId'],
      garmin: ['garminUserId', 'garminAccessToken', 'garminAccessTokenSecret'],
    };

    const columns = providerColumns[ctx.params.provider];

    await pool.query(
      sql`UPDATE user SET ${join(
        columns.map((col) => sql`${raw(col)} = NULL`),
        ',',
      )} WHERE id = ${ctx.state.user.id}`,
    );

    ctx.status = 204;
  });
}
