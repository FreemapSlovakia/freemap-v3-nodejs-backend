import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';

export function attachDeleteAppTokenHandler(router: RouterInstance) {
  registerPath('/auth/app-tokens/{id}', {
    delete: {
      summary: 'Revoke an app token',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: z.uint32() }),
      },
      responses: {
        204: {},
        401: {},
        404: { description: 'no such app token' },
      },
    },
  });

  router.delete('/app-tokens/:id', authenticator(true), async (ctx) => {
    const { affectedRows } = await pool.query<{ affectedRows: number }>(
      sql`DELETE FROM appToken WHERE id = ${ctx.params.id} AND userId = ${ctx.state.user!.id}`,
    );

    if (!affectedRows) {
      ctx.throw(404, 'no such app token');
    }

    ctx.status = 204;
  });
}
