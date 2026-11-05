import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import {
  changesMailbox,
  emailFieldsSql,
  nextEmail,
} from '../../emailAddress.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import {
  MAX_PICTURE_INPUT_BYTES,
  processProfilePicture,
} from '../../profilePicture.js';
import {
  type PublicField,
  PublicFieldSchema,
  removesLastWayIn,
  USER_COLUMNS_SQL,
  UserRowSchema,
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
    emailReminderOff: z.boolean().optional(),
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
        k !== 'email' &&
        body[k] !== undefined,
    );

    const { settings, publicFields } = body;

    if (
      keys.length === 0 &&
      processedPicture === undefined &&
      settings === undefined &&
      publicFields === undefined &&
      body.email === undefined
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
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${userId} FOR UPDATE`,
      );

      if (!rawRow) {
        return ctx.throw(401, 'account gone');
      }

      const row = UserRowSchema.parse(rawRow);

      // Per attempt: a retried transaction starts again from the row it reads.
      const sets = [...assignments];

      const next =
        body.email === undefined || body.email === row.email
          ? undefined
          : nextEmail(row, body.email);

      // Another mailbox only through PUT /auth/email, which proves it. Skipped,
      // not refused: older clients send `email` with every save.
      const applied =
        next && (body.email === null || !changesMailbox(row, next))
          ? next
          : undefined;

      if (applied) {
        if (removesLastWayIn(row, applied.emailVerified)) {
          return ctx.throw(409, 'last provider');
        }

        sets.push(emailFieldsSql(applied));

        // Removing it is the answer to being asked for one.
        if (body.email === null && body.emailReminderOff === undefined) {
          sets.push(sql`emailReminderOff = true`);
        }
      }

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
        const email = applied ? applied.email : row.email;

        const present: Record<PublicField, unknown> = {
          // Kept for an unproven one too, which the profile shows once proven.
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
