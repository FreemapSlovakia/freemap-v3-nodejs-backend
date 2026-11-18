import Router from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql, { join } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import {
  dropStaleMatches,
  EventFilterSchema,
  MAX_EVENT_FILTERS,
  notifySets,
} from '../../eventFilter.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const router = new Router();

const NameSchema = z.string().trim().min(1).max(100);

const SavedFilterSchema = z
  .strictObject({
    id: z.number().int(),
    name: z.string(),
    filter: EventFilterSchema,
    notify: z
      .boolean()
      .describe('Whether newly added events matching it are emailed'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SavedEventFilter' });

const CreateBodySchema = z
  .strictObject({
    name: NameSchema,
    filter: EventFilterSchema,
    notify: z.boolean().default(false),
  })
  .meta({ id: 'SavedEventFilterCreate' });

const PatchBodySchema = z
  .strictObject({
    name: NameSchema.optional(),
    filter: EventFilterSchema.optional(),
    notify: z.boolean().optional(),
  })
  .meta({ id: 'SavedEventFilterPatch' });

// TODO one stored filter the schema no longer accepts fails the whole list.
const RowSchema = z.object({
  id: z.number(),
  name: z.string(),
  // The driver parses a JSON column; a string where it didn't.
  filter: z.preprocess(
    (v) => (typeof v === 'string' ? JSON.parse(v) : v),
    EventFilterSchema,
  ),
  notify: z.coerce.boolean(),
  createdAt: z.date(),
});

const COLUMNS = sql`id, name, filter, notify, createdAt`;

const toResponse = (row: z.infer<typeof RowSchema>) =>
  SavedFilterSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });

function filterId(ctx: ParameterizedContext) {
  const id = Number(ctx.params['id']);

  return Number.isSafeInteger(id) && id > 0 ? id : ctx.throw(404);
}

function parseBody<T>(ctx: ParameterizedContext, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(ctx.request.body);

  return parsed.success ? parsed.data : ctx.throw(400, parsed.error);
}

const IdParamsSchema = z.object({ id: z.number().int() });

registerPath('/event-filters', {
  get: {
    summary: 'Your saved events filters',
    tags: ['event-filters'],
    security: AUTH_REQUIRED,
    responses: {
      200: {
        content: {
          'application/json': { schema: SavedFilterSchema.array() },
        },
      },
      401: {},
    },
  },
  post: {
    summary: 'Save an events filter',
    tags: ['event-filters'],
    security: AUTH_REQUIRED,
    requestBody: {
      content: { 'application/json': { schema: CreateBodySchema } },
    },
    responses: {
      200: { content: { 'application/json': { schema: SavedFilterSchema } } },
      401: {},
      409: { description: `already ${MAX_EVENT_FILTERS} saved` },
    },
  },
});

registerPath('/event-filters/{id}', {
  patch: {
    summary: 'Rename a saved events filter, change it or its emails',
    tags: ['event-filters'],
    security: AUTH_REQUIRED,
    requestParams: { path: IdParamsSchema },
    requestBody: {
      content: { 'application/json': { schema: PatchBodySchema } },
    },
    responses: {
      200: { content: { 'application/json': { schema: SavedFilterSchema } } },
      401: {},
      404: {},
    },
  },
  delete: {
    summary: 'Delete a saved events filter',
    tags: ['event-filters'],
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
    const rows = RowSchema.array().parse(
      await pool.query<unknown>(sql`
        SELECT ${COLUMNS} FROM eventFilter
        WHERE userId = ${ctx.state.user!.id}
        ORDER BY name, id
      `),
    );

    ctx.body = rows.map(toResponse);
  },
);

router.post(
  '/',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    const body = parseBody(ctx, CreateBodySchema);

    const userId = ctx.state.user!.id;

    const row = await runInTransaction(async (conn) => {
      // The user's row, so two saves at once can't both pass the count.
      await conn.query(
        sql`SELECT id FROM user WHERE id = ${userId} FOR UPDATE`,
      );

      const [{ count }] = await conn.query<{ count: number }[]>(
        sql`SELECT COUNT(*) AS count FROM eventFilter WHERE userId = ${userId}`,
      );

      if (count >= MAX_EVENT_FILTERS) {
        return null;
      }

      const { insertId } = await conn.query<{ insertId: number }>(sql`
        INSERT INTO eventFilter SET
          userId = ${userId},
          name = ${body.name},
          filter = ${JSON.stringify(body.filter)},
          notify = ${body.notify}
      `);

      const [inserted] = await conn.query<unknown[]>(
        sql`SELECT ${COLUMNS} FROM eventFilter WHERE id = ${insertId}`,
      );

      return RowSchema.parse(inserted);
    });

    if (!row) {
      return ctx.throw(409, `already ${MAX_EVENT_FILTERS} saved filters`);
    }

    ctx.body = toResponse(row);
  },
);

router.patch(
  '/:id',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    const id = filterId(ctx);

    const body = parseBody(ctx, PatchBodySchema);

    const filter =
      body.filter === undefined ? undefined : JSON.stringify(body.filter);

    // Emails cover events added from now on once the conditions change; a
    // rename keeps them going. Before `filter =`, as MariaDB reads the row's
    // values as each assignment leaves them.
    const sets = [
      ...(filter === undefined
        ? []
        : [
            sql`matchSince = IF(JSON_EQUALS(filter, ${filter}), matchSince, NOW())`,
            sql`filter = ${filter}`,
          ]),
      ...(body.name === undefined ? [] : [sql`name = ${body.name}`]),
      ...(body.notify === undefined ? [] : notifySets(body.notify)),
    ];

    const userId = ctx.state.user!.id;

    if (sets.length) {
      await runInTransaction(async (conn) => {
        const { affectedRows } = await conn.query<{ affectedRows: number }>(
          sql`
            UPDATE eventFilter SET ${join(sets)}
            WHERE id = ${id} AND userId = ${userId}
          `,
        );

        if (affectedRows) {
          await dropStaleMatches(conn, id);
        }
      });
    }

    const [row] = await pool.query<unknown[]>(
      sql`SELECT ${COLUMNS} FROM eventFilter WHERE id = ${id} AND userId = ${userId}`,
    );

    if (!row) {
      return ctx.throw(404);
    }

    ctx.body = toResponse(RowSchema.parse(row));
  },
);

router.delete('/:id', authenticator(true), async (ctx) => {
  const { affectedRows } = await pool.query<{ affectedRows: number }>(sql`
    DELETE FROM eventFilter
    WHERE id = ${filterId(ctx)} AND userId = ${ctx.state.user!.id}
  `);

  if (!affectedRows) {
    return ctx.throw(404);
  }

  ctx.status = 204;
});

export const eventFiltersRouter = router;
