import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import {
  MAX_PICTURE_INPUT_BYTES,
  processProfilePicture,
} from '../../profilePicture.js';
import {
  knownValues,
  type PublicField,
  PublicFieldSchema,
} from '../../types.js';

// base64 inflates ~33%, so cap the encoded length proportionally.
const MAX_PICTURE_BASE64_LEN = Math.ceil((MAX_PICTURE_INPUT_BYTES * 4) / 3);

const BodySchema = z
  .strictObject({
    name: z.string().optional(),
    email: z.email().nullish(),
    description: z.string().nullish(),
    // The home location; `null` removes it.
    lat: z.number().min(-90).max(90).nullish(),
    lon: z.number().min(-180).max(180).nullish(),
    settings: z.record(z.string(), z.unknown()).optional(),
    sendGalleryEmails: z.boolean().nullish(),
    language: z.string().min(2).max(2).nullish(),
    publicFields: z.array(PublicFieldSchema).optional(),
    picture: z
      .union([z.base64().max(MAX_PICTURE_BASE64_LEN), z.null()])
      .optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  })
  .refine((data) => (data.lat == null) === (data.lon == null), {
    message: 'lat and lon go together',
  });

const LockedRowSchema = z.object({
  settings: z.record(z.string(), z.unknown()).nullable(),
  publicFields: knownValues(PublicFieldSchema),
  email: z.string().nullable(),
  osmId: z.uint32().nullable(),
  githubUserId: z.string().nullable(),
  stravaUserId: z.string().nullable(),
});

export function attachPatchUserHandler(router: RouterInstance) {
  registerPath('/auth/settings', {
    patch: {
      summary: 'Update authenticated user settings',
      description:
        '`settings` is merged into the stored settings by top-level key; a `null` value removes the key.',
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
      (k) =>
        k !== 'picture' &&
        k !== 'settings' &&
        k !== 'publicFields' &&
        body[k] !== undefined,
    );

    const { settings, publicFields } = body;

    if (
      keys.length === 0 &&
      processedPicture === undefined &&
      settings === undefined &&
      publicFields === undefined
    ) {
      ctx.status = 204;

      return;
    }

    // TODO validate duplicates

    const assignments = keys.map((key) => sql`${raw(key)} = ${body[key]}`);

    if (processedPicture !== undefined) {
      assignments.push(sql`picture = ${processedPicture}`);
    }

    const userId = ctx.state.user!.id;

    // Only these depend on the stored row; anything else is a plain write.
    if (
      settings === undefined &&
      publicFields === undefined &&
      body.email === undefined
    ) {
      await pool.query<unknown>(
        sql`UPDATE user SET ${join(assignments)} WHERE id = ${userId}`,
      );

      ctx.status = 204;

      return;
    }

    await runInTransaction(async (conn) => {
      // Under the lock, as the disconnect handler reads it.
      const [rawRow] = await conn.query<unknown[]>(
        sql`SELECT settings, publicFields, email, osmId, githubUserId, stravaUserId
          FROM user WHERE id = ${userId} FOR UPDATE`,
      );

      if (!rawRow) {
        return ctx.throw(401, 'account gone');
      }

      const row = LockedRowSchema.parse(rawRow);

      // Per attempt: a retried transaction starts again from the row it reads.
      const sets = [...assignments];

      if (settings !== undefined) {
        // Clients each own their top-level keys (the mobile app keeps
        // `freemapApp`), so one client's save must not drop another's. Not
        // JSON_MERGE_PATCH: its recursion would keep entries deleted inside a
        // key's value.
        const merged = { ...row.settings };

        for (const [k, v] of Object.entries(settings)) {
          if (v === null) {
            delete merged[k];
          } else {
            merged[k] = v;
          }
        }

        sets.push(sql`settings = ${JSON.stringify(merged)}`);
      }

      if (publicFields !== undefined || body.email !== undefined) {
        // Only what there is to show now: a flag set ahead of an email or a
        // login would publish it unasked once it comes.
        const email = body.email === undefined ? row.email : body.email;

        const present: Record<PublicField, unknown> = {
          email: email || null,
          osm: row.osmId,
          github: row.githubUserId,
          strava: row.stravaUserId,
        };

        const allowed = [...new Set(publicFields ?? row.publicFields)].filter(
          (f) => present[f] != null,
        );

        sets.push(sql`publicFields = ${JSON.stringify(allowed)}`);
      }

      await conn.query<unknown>(
        sql`UPDATE user SET ${join(sets)} WHERE id = ${userId}`,
      );
    });

    ctx.status = 204;
  });
}
