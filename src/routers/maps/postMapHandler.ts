import { RouterInstance } from '@koa/router';
import sql, { bulk } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema } from '../../types.js';

const BodySchema = z.strictObject({
  name: z.string().min(1).max(255),
  data: z.record(z.string(), z.unknown()).optional(),
  public: z.boolean().optional(),
  writers: z.array(z.uint32()).optional(),
});

export function attachPostMapHandler(router: RouterInstance) {
  registerPath('/maps', {
    post: {
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: { content: { 'application/json': { schema: MapMetaSchema } } },
        401: {},
      },
    },
  });

  router.post(
    '/',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { name, public: pub, data, writers } = body;

      const id = nanoid();

      const now = new Date();

      const userId = ctx.state.user!.id;

      await pool.query(sql`
        INSERT INTO map SET
          id = ${id},
          name = ${name},
          public = ${pub},
          userId = ${userId},
          createdAt = ${now},
          modifiedAt = ${now},
          data = ${JSON.stringify(data)}
      `);

      if (writers?.length) {
        await pool.query(
          sql`INSERT INTO mapWriteAccess (mapId, userId) VALUES ${bulk(writers.map((writer) => [id, writer]))}`,
        );
      }

      ctx.body = MapMetaSchema.parse({
        id,
        createdAt: now.toISOString(),
        modifiedAt: now.toISOString(),
        public: !!pub,
        writers,
        name,
        userId,
        canWrite: true,
      });
    },
  );
}
