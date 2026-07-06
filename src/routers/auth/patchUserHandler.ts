import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import {
  MAX_PICTURE_INPUT_BYTES,
  processProfilePicture,
} from '../../profilePicture.js';

// base64 inflates ~33%, so cap the encoded length proportionally.
const MAX_PICTURE_BASE64_LEN = Math.ceil((MAX_PICTURE_INPUT_BYTES * 4) / 3);

const BodySchema = z
  .strictObject({
    name: z.string().optional(),
    email: z.email().nullish(),
    description: z.string().nullish(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    sendGalleryEmails: z.boolean().nullish(),
    language: z.string().min(2).max(2).nullish(),
    picture: z
      .union([z.base64().max(MAX_PICTURE_BASE64_LEN), z.null()])
      .optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export function attachPatchUserHandler(router: RouterInstance) {
  registerPath('/auth/settings', {
    patch: {
      summary: 'Update authenticated user settings',
      tags: ['auth'],
      security: AUTH_REQUIRED,
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

    let processedPicture: Buffer | null | undefined;

    if (body.picture !== undefined) {
      if (body.picture === null) {
        processedPicture = null;
      } else {
        try {
          processedPicture = await processProfilePicture(
            Buffer.from(body.picture, 'base64'),
          );
        } catch (err) {
          ctx.log.warn({ err }, 'invalid profile picture upload');

          return ctx.throw(400, 'invalid picture');
        }
      }
    }

    const keys = (Object.keys(body) as (keyof typeof body)[]).filter(
      (k) => k !== 'picture' && body[k] !== undefined,
    );

    if (keys.length === 0 && processedPicture === undefined) {
      ctx.status = 204;

      return;
    }

    // TODO validate duplicates

    const assignments = keys.map(
      (key) =>
        sql`${raw(key)} = ${key === 'settings' ? JSON.stringify(body[key]) : body[key]}`,
    );

    if (processedPicture !== undefined) {
      assignments.push(sql`picture = ${processedPicture}`);
    }

    await pool.query<unknown>(
      sql`UPDATE user SET ${join(assignments)} WHERE id = ${ctx.state.user!.id}`,
    );

    ctx.status = 204;
  });
}
