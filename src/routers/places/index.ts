import Router from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql, { join } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import {
  FREE_PLACES,
  lockPlacesOwner,
  MAX_PLACES,
  mirrorLegacyHome,
  PlaceRowSchema,
  placesOf,
} from '../../places.js';
import { acceptValidator } from '../../requestValidators.js';

const router = new Router();

const NameSchema = z.string().trim().min(1).max(100);

const LatSchema = z.number().min(-90).max(90);

const LonSchema = z.number().min(-180).max(180);

const PlaceSchema = z
  .strictObject({
    id: z.number().int(),
    name: z.string(),
    lat: z.number(),
    lon: z.number(),
  })
  .meta({ id: 'Place' });

const CreateBodySchema = z
  .strictObject({ name: NameSchema, lat: LatSchema, lon: LonSchema })
  .meta({ id: 'PlaceCreate' });

const PatchBodySchema = z
  .strictObject({
    name: NameSchema.optional(),
    lat: LatSchema.optional(),
    lon: LonSchema.optional(),
  })
  .refine((b) => (b.lat === undefined) === (b.lon === undefined), {
    message: 'lat and lon go together',
  })
  .meta({ id: 'PlacePatch' });

const IdParamsSchema = z.object({ id: z.number().int() });

function placeId(ctx: ParameterizedContext) {
  const id = Number(ctx.params['id']);

  return Number.isSafeInteger(id) && id > 0 ? id : ctx.throw(404);
}

function parseBody<T>(ctx: ParameterizedContext, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(ctx.request.body);

  return parsed.success ? parsed.data : ctx.throw(400, parsed.error);
}

registerPath('/places', {
  get: {
    summary: 'Your places',
    description:
      'In the order they were added. The first one is also the legacy home location (`coordinates` of the user, `lat`/`lon` of `PATCH /auth/settings`).',
    tags: ['places'],
    security: AUTH_REQUIRED,
    responses: {
      200: { content: { 'application/json': { schema: PlaceSchema.array() } } },
      401: {},
    },
  },
  post: {
    summary: 'Add a place',
    tags: ['places'],
    security: AUTH_REQUIRED,
    requestBody: {
      content: { 'application/json': { schema: CreateBodySchema } },
    },
    responses: {
      200: { content: { 'application/json': { schema: PlaceSchema } } },
      401: {},
      403: { description: `more than ${FREE_PLACES} needs premium` },
      409: { description: `already ${MAX_PLACES} places` },
    },
  },
});

registerPath('/places/{id}', {
  patch: {
    summary: 'Rename or move a place',
    tags: ['places'],
    security: AUTH_REQUIRED,
    requestParams: { path: IdParamsSchema },
    requestBody: {
      content: { 'application/json': { schema: PatchBodySchema } },
    },
    responses: {
      200: { content: { 'application/json': { schema: PlaceSchema } } },
      401: {},
      404: {},
    },
  },
  delete: {
    summary: 'Delete a place',
    tags: ['places'],
    security: AUTH_REQUIRED,
    requestParams: { path: IdParamsSchema },
    responses: { 204: {}, 401: {}, 404: {} },
  },
});

router.get(
  '/',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    ctx.body = await placesOf(pool, ctx.state.user!.id);
  },
);

router.post(
  '/',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    const body = parseBody(ctx, CreateBodySchema);

    const userId = ctx.state.user!.id;

    const result = await runInTransaction(async (conn) => {
      const premium = await lockPlacesOwner(conn, userId);

      if (premium === null) {
        return 401;
      }

      const { length } = await placesOf(conn, userId);

      if (length >= MAX_PLACES) {
        return 409;
      }

      // Kept when premium lapses, but no more added.
      if (!premium && length >= FREE_PLACES) {
        return 403;
      }

      const { insertId } = await conn.query<{ insertId: number }>(sql`
        INSERT INTO userPlace SET
          userId = ${userId},
          name = ${body.name},
          lat = ${body.lat},
          lon = ${body.lon}
      `);

      // Only the first place is the legacy home.
      if (length === 0) {
        await mirrorLegacyHome(conn, userId);
      }

      const [inserted] = await conn.query<unknown[]>(
        sql`SELECT id, name, lat, lon FROM userPlace WHERE id = ${insertId}`,
      );

      return PlaceRowSchema.parse(inserted);
    });

    if (result === 401) {
      return ctx.throw(401, 'account gone');
    }

    if (result === 409) {
      return ctx.throw(409, `already ${MAX_PLACES} places`);
    }

    if (result === 403) {
      return ctx.throw(403, 'premium required');
    }

    ctx.body = result;
  },
);

router.patch(
  '/:id',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    const id = placeId(ctx);

    const body = parseBody(ctx, PatchBodySchema);

    const userId = ctx.state.user!.id;

    const sets = [
      ...(body.name === undefined ? [] : [sql`name = ${body.name}`]),
      ...(body.lat === undefined
        ? []
        : [sql`lat = ${body.lat}`, sql`lon = ${body.lon}`]),
    ];

    const row = await runInTransaction(async (conn) => {
      if (sets.length) {
        await lockPlacesOwner(conn, userId);

        const { affectedRows } = await conn.query<{ affectedRows: number }>(
          sql`UPDATE userPlace SET ${join(sets)} WHERE id = ${id} AND userId = ${userId}`,
        );

        // A rename can't move the legacy home.
        if (affectedRows && body.lat !== undefined) {
          await mirrorLegacyHome(conn, userId);
        }
      }

      const [found] = await conn.query<unknown[]>(
        sql`SELECT id, name, lat, lon FROM userPlace WHERE id = ${id} AND userId = ${userId}`,
      );

      return found;
    });

    if (!row) {
      return ctx.throw(404);
    }

    ctx.body = PlaceRowSchema.parse(row);
  },
);

router.delete('/:id', authenticator(true), async (ctx) => {
  const id = placeId(ctx);

  const userId = ctx.state.user!.id;

  const deleted = await runInTransaction(async (conn) => {
    await lockPlacesOwner(conn, userId);

    const { affectedRows } = await conn.query<{ affectedRows: number }>(
      sql`DELETE FROM userPlace WHERE id = ${id} AND userId = ${userId}`,
    );

    if (affectedRows) {
      await mirrorLegacyHome(conn, userId);
    }

    return affectedRows > 0;
  });

  if (!deleted) {
    return ctx.throw(404);
  }

  ctx.status = 204;
});

export const placesRouter = router;
