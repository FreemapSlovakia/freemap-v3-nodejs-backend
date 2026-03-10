import { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';

const BodySchema = z
  .strictObject({
    name: z.string().optional(),
    email: z.string().email().nullable().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    sendGalleryEmails: z.boolean().nullable().optional(),
    language: z.string().min(2).max(2).nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export function attachPatchUserHandler(router: RouterInstance) {
  registerPath('/auth/settings', {
    patch: {
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: { 204: {}, 400: {}, 401: {} },
    },
  });

  router.patch('/settings', authenticator(true), async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const keys = (Object.keys(body) as (keyof typeof body)[]).filter(
      (k) => body[k] !== undefined,
    );

    // TODO validate duplicates

    await pool.query(
      sql`UPDATE user SET ${join(
        keys.map(
          (key) =>
            sql`${raw(key)} = ${key === 'settings' ? JSON.stringify(body[key]) : body[key]}`,
        ),
      )} WHERE id = ${ctx.state.user!.id}`,
    );

    ctx.status = 204;
  });
}
