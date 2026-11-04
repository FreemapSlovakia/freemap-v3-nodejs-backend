import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { appLogger } from '../../logger.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  COVER_NAME_RE,
  COVER_SIZES,
  type CoverSize,
  coverPath,
  MAX_COVER_INPUT_BYTES,
  removeCover,
  storeCover,
} from './cover.js';
import {
  canWriteEvent,
  EventRowSchema,
  EventSchema,
  eventRowToResponse,
  eventSelect,
} from './types.js';

const logger = appLogger.child({ module: 'eventCover' });

const IdParamsSchema = z.object({ id: z.string().nonempty() });

/**
 * Sets the event's cover to `name` (or none), checking write access under the
 * row lock, and answers with the event; the replaced cover's files go after
 * the commit.
 */
async function setCover(
  ctx: ParameterizedContext,
  id: string,
  name: string | null,
) {
  const old = await runInTransaction(async (conn) => {
    const [existing] = z
      .array(z.object({ userId: z.uint32(), cover: z.string().nullable() }))
      .max(1)
      .parse(
        await conn.query<unknown>(
          sql`SELECT userId, cover FROM event WHERE id = ${id} FOR UPDATE`,
        ),
      );

    if (!existing) {
      ctx.throw(404, 'no such event');
    }

    if (!canWriteEvent(ctx.state.user, existing)) {
      ctx.throw(403);
    }

    await conn.query<unknown>(
      sql`UPDATE event SET cover = ${name} WHERE id = ${id}`,
    );

    const [row] = EventRowSchema.array()
      .length(1)
      .parse(
        await conn.query<unknown>(
          sql`${eventSelect(ctx.state.user)} WHERE e.id = ${id}`,
        ),
      );

    ctx.body = eventRowToResponse(row, ctx.state.user);

    return existing.cover;
  });

  if (old && old !== name) {
    await removeCover(old, logger);
  }
}

export function attachEventCoverHandlers(router: RouterInstance) {
  registerPath('/events/{id}/cover', {
    put: {
      summary: "Set an event's cover image (owner only)",
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: IdParamsSchema },
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: z.object({ image: z.file() }),
          },
        },
      },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        400: { description: 'missing or unreadable image' },
        401: {},
        403: {},
        404: { description: 'no such event' },
        413: { description: 'image too large' },
      },
    },
    delete: {
      summary: "Remove an event's cover image (owner only)",
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: { path: IdParamsSchema },
      responses: {
        200: { content: { 'application/json': { schema: EventSchema } } },
        401: {},
        403: {},
        404: { description: 'no such event' },
      },
    },
  });

  router.put(
    '/:id/cover',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      const image = ctx.request.files?.image;

      if (!image || Array.isArray(image)) {
        return ctx.throw(400, 'missing image file');
      }

      if (image.size > MAX_COVER_INPUT_BYTES) {
        return ctx.throw(413, 'image too large');
      }

      // Checked before the costly resize too, which the lock can't be held over.
      const [owner] = await pool.query<{ userId: number }[]>(
        sql`SELECT userId FROM event WHERE id = ${ctx.params.id}`,
      );

      if (!owner) {
        return ctx.throw(404, 'no such event');
      }

      if (!canWriteEvent(ctx.state.user, owner)) {
        return ctx.throw(403);
      }

      let name;

      try {
        name = await storeCover(image.filepath);
      } catch {
        return ctx.throw(400, 'invalid or unsupported image file');
      }

      try {
        await setCover(ctx, ctx.params.id, name);
      } catch (err) {
        await removeCover(name, logger);

        throw err;
      }
    },
  );

  router.delete(
    '/:id/cover',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      await setCover(ctx, ctx.params.id, null);
    },
  );

  registerPath('/events/covers/{name}', {
    get: {
      summary: 'Get an event cover image',
      tags: ['events'],
      requestParams: {
        path: z.object({ name: z.string().regex(COVER_NAME_RE) }),
        query: z.object({ size: z.enum(['large', 'thumb']).optional() }),
      },
      responses: {
        200: { content: { 'image/webp': {} } },
        404: { description: 'no such cover' },
      },
    },
  });

  router.get('/covers/:name', async (ctx) => {
    const { name } = ctx.params;

    const size = ctx.query.size ?? 'large';

    if (
      !COVER_NAME_RE.test(name) ||
      typeof size !== 'string' ||
      !Object.hasOwn(COVER_SIZES, size)
    ) {
      return ctx.throw(404, 'no such cover');
    }

    const path = coverPath(name, size as CoverSize);

    let stats;

    try {
      stats = await stat(path);
    } catch {
      return ctx.throw(404, 'no such cover');
    }

    // A cover's name changes with its image, so its files never do.
    ctx.set('Cache-Control', 'public, max-age=31536000, immutable');

    ctx.type = 'image/webp';

    ctx.length = stats.size;

    ctx.body = createReadStream(path);
  });
}
