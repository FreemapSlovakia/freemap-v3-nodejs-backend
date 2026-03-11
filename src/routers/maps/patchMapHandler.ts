import { RouterInstance } from '@koa/router';
import sql, { bulk, empty } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema, zDateToIso } from '../../types.js';

const BodySchema = z.strictObject({
  name: z.string().min(1).max(255).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  public: z.boolean().optional(),
  writers: z.array(z.uint32()).optional().meta({ description: 'User IDs' }),
});

const DbRowSchema = z.object({
  userId: z.uint32(),
  name: z.string().nullable(),
  createdAt: zDateToIso,
  modifiedAt: z.date(),
  public: z.number().transform(Boolean),
});

export function attachPatchMapHandler(router: RouterInstance) {
  registerPath('/maps/{id}', {
    patch: {
      summary: 'Update map metadata or data',
      tags: ['maps'],
      security: AUTH_REQUIRED,
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: BodySchema,
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: MapMetaSchema,
            },
          },
        },
        401: {},
        403: {},
        404: { description: 'no such map' },
        412: {},
      },
    },
  });

  router.patch(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { id } = ctx.params;

      await runInTransaction(async (conn) => {
        const [item] = DbRowSchema.array()
          .max(1)
          .parse(
            await conn.query(
              sql`SELECT userId, name, createdAt, modifiedAt, public FROM map WHERE id = ${id} FOR UPDATE`,
            ),
          );

        if (!item) {
          ctx.throw(404, 'no such map');
        }

        const curWriters = (
          await conn.query(
            sql`SELECT userId FROM mapWriteAccess WHERE mapId = ${id} FOR UPDATE`,
          )
        ).map(({ userId }: { userId: number }) => userId);

        const { name, public: pub, data, writers } = body;

        const user = ctx.state.user!;

        if (
          !user.isAdmin &&
          item.userId !== user.id &&
          (!curWriters.includes(user.id) ||
            writers !== undefined ||
            pub !== undefined ||
            name !== undefined)
        ) {
          ctx.throw(403);
        }

        if (
          ctx.request.headers['if-unmodified-since'] &&
          new Date(ctx.request.headers['if-unmodified-since']).getTime() <
            item.modifiedAt.getTime()
        ) {
          ctx.throw(412);
        }

        const now = new Date();

        await conn.query(sql`UPDATE map SET modifiedAt = ${now}
            ${name === undefined ? empty : sql`, name = ${name}`}
            ${pub === undefined ? empty : sql`, public = ${pub}`}
            ${data === undefined ? empty : sql`, data = ${JSON.stringify(data)}`}
            WHERE id = ${id}
          `);

        if (writers) {
          conn.query(sql`DELETE FROM mapWriteAccess WHERE mapId = ${id}`);

          if (writers.length) {
            await conn.query(
              sql`INSERT INTO mapWriteAccess (mapId, userId) VALUES ${bulk(writers.map((writer: number) => [id, writer]))}`,
            );
          }
        }

        ctx.body = MapMetaSchema.parse({
          id,
          createdAt: item.createdAt,
          modifiedAt: now.toISOString(),
          public: pub ?? item.public,
          writers: writers ?? curWriters,
          name: name ?? item.name,
          userId: item.userId,
          canWrite: true,
        });
      });
    },
  );
}
