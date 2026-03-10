import { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';

export function attachDisconnectHandler(router: RouterInstance) {
  registerPath('/auth/providers/{provider}', {
    delete: {
      parameters: [
        {
          in: 'path',
          name: 'provider',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: { 204: {}, 401: {} },
    },
  });

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
      )} WHERE id = ${ctx.state.user!.id}`,
    );

    ctx.status = 204;
  });
}
