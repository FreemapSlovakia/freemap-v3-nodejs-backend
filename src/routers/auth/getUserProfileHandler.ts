import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso } from '../../types.js';

const ProfileDbSchema = z.object({
  id: z.uint32(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: zDateToIso,
  hasPicture: z.coerce.boolean(),
  premium: z.coerce.boolean(),
  pictureCount: z.coerce.number(),
  commentCount: z.coerce.number(),
  eventCount: z.coerce.number(),
});

const ProfileSchema = z
  .object({
    id: z.uint32(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: z.iso.datetime(),
    hasPicture: z.boolean(),
    premium: z.boolean(),
    gallery: z.object({
      pictureCount: z.uint32(),
      /** Comments the user wrote. */
      commentCount: z.uint32(),
    }),
    /** Public events the user organizes. */
    eventCount: z.uint32(),
  })
  .meta({ id: 'UserProfile' });

export function attachGetUserProfileHandler(router: RouterInstance) {
  registerPath('/auth/users/{id}/profile', {
    get: {
      summary: "Get a user's public profile",
      tags: ['auth'],
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ProfileSchema } },
        },
        404: { description: 'no such user' },
      },
    },
  });

  router.get(
    '/users/:id/profile',
    acceptValidator('application/json'),
    async (ctx) => {
      const id = Number(ctx.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        ctx.throw(404, 'no such user');
      }

      const [row] = await pool.query<unknown[]>(
        sql`SELECT
            id,
            name,
            description,
            createdAt,
            picture IS NOT NULL AS hasPicture,
            (premiumExpiration IS NOT NULL AND premiumExpiration > NOW()) AS premium,
            (SELECT COUNT(*) FROM picture WHERE userId = ${id}) AS pictureCount,
            (SELECT COUNT(*) FROM pictureComment WHERE userId = ${id})
              + (SELECT COUNT(*) FROM wikimediaComment WHERE userId = ${id})
              AS commentCount,
            (SELECT COUNT(*) FROM event WHERE userId = ${id} AND visibility = 'public')
              AS eventCount
          FROM user
          WHERE id = ${id}`,
      );

      if (!row) {
        return ctx.throw(404, 'no such user');
      }

      const p = ProfileDbSchema.parse(row);

      ctx.body = ProfileSchema.parse({
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt,
        hasPicture: p.hasPicture,
        premium: p.premium,
        gallery: {
          pictureCount: p.pictureCount,
          commentCount: p.commentCount,
        },
        eventCount: p.eventCount,
      });
    },
  );
}
