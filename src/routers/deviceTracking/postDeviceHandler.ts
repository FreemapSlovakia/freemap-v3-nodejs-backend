import { RouterInstance } from '@koa/router';
import { SqlError } from 'mariadb';
import sql from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachPostDeviceHandler(router: RouterInstance) {
  router.post(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      type Body = {
        name: string & tags.MinLength<1> & tags.MaxLength<255>;
        maxCount?: (number & tags.Type<'uint32'>) | null;
        maxAge?: (number & tags.Type<'uint32'>) | null;
        token?: string;
      };

      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { name, maxCount, maxAge, token = '' } = body;

      const okToken = token || nanoid();

      try {
        const { insertId } = await pool.query(sql`
          INSERT INTO trackingDevice SET
            name = ${name},
            token = ${okToken},
            userId = ${ctx.state.user!.id},
            maxCount = ${maxCount},
            maxAge = ${maxAge}
        `);

        ctx.body = { id: insertId, token: okToken };
      } catch (err) {
        if (err instanceof SqlError && err.errno === 1062) {
          ctx.throw(409);
        }

        throw err;
      }
    },
  );
}
