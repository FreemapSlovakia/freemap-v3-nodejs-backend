import Router from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import {
  type MailTarget,
  MailTargetSchema,
  parseWatchToken,
  setWatch,
  targetExists,
  watchState,
} from '../../mailWatch.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const router = new Router();

const ParamsSchema = z.object({
  target: MailTargetSchema,
  targetId: z.string().regex(/^[\w-]{1,16}$/),
});

const StateSchema = z
  .strictObject({
    watching: z.boolean(),
    enabled: z
      .boolean()
      .describe('Whether the account gets this kind of email at all'),
  })
  .meta({ id: 'MailWatchState' });

const WatchBodySchema = z
  .strictObject({ watching: z.boolean() })
  .meta({ id: 'MailWatchBody' });

const TokenBodySchema = z
  .strictObject({
    token: z.string(),
    watching: z
      .boolean()
      .optional()
      .describe('Left out, the state is only read'),
  })
  .meta({ id: 'MailWatchTokenBody' });

const TokenResponseSchema = z
  .strictObject({
    target: MailTargetSchema,
    targetId: z.string(),
    title: z.string().nullable(),
    watching: z.boolean(),
  })
  .meta({ id: 'MailWatchTokenResult' });

function params(ctx: ParameterizedContext) {
  const parsed = ParamsSchema.safeParse(ctx.params);

  return parsed.success ? parsed.data : ctx.throw(404);
}

async function targetTitle(target: MailTarget, targetId: string) {
  if (target === 'wikimedia') {
    return null;
  }

  const [row] = await pool.query<{ title: string | null }[]>(
    target === 'event'
      ? sql`SELECT title FROM event WHERE id = ${targetId}`
      : sql`SELECT title FROM picture WHERE id = ${targetId}`,
  );

  return row?.title ?? null;
}

registerPath('/mail-watch/{target}/{targetId}', {
  get: {
    summary: 'Whether you get the emails about an event or photo',
    tags: ['mail-watch'],
    security: AUTH_REQUIRED,
    requestParams: { path: ParamsSchema },
    responses: {
      200: { content: { 'application/json': { schema: StateSchema } } },
      401: {},
    },
  },
  put: {
    summary: 'Follow or mute the emails about an event or photo',
    tags: ['mail-watch'],
    security: AUTH_REQUIRED,
    requestParams: { path: ParamsSchema },
    requestBody: {
      content: { 'application/json': { schema: WatchBodySchema } },
    },
    responses: {
      200: { content: { 'application/json': { schema: StateSchema } } },
      401: {},
    },
  },
});

registerPath('/mail-watch/token', {
  post: {
    summary: "Follow or mute by an email's link, without logging in",
    tags: ['mail-watch'],
    requestBody: {
      content: { 'application/json': { schema: TokenBodySchema } },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: TokenResponseSchema } },
      },
      404: { description: 'invalid token' },
      410: { description: 'the event or photo no longer exists' },
    },
  },
});

registerPath('/mail-watch/unsubscribe', {
  post: {
    summary: 'One-click unsubscribe (RFC 8058) from an email header',
    tags: ['mail-watch'],
    requestParams: { query: z.object({ token: z.string() }) },
    responses: { 204: {}, 404: { description: 'invalid token' } },
  },
});

router.get(
  '/:target/:targetId',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    const { target, targetId } = params(ctx);

    const state = await watchState(pool, ctx.state.user!.id, target, targetId);

    if (!state) {
      return ctx.throw(401, 'account gone');
    }

    ctx.body = StateSchema.parse({
      watching: state.watching,
      enabled: state.enabled,
    });
  },
);

router.put(
  '/:target/:targetId',
  acceptValidator('application/json'),
  authenticator(true),
  async (ctx) => {
    const { target, targetId } = params(ctx);

    let body;

    try {
      body = WatchBodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const state = await setWatch(
      pool,
      ctx.state.user!.id,
      target,
      targetId,
      body.watching,
    );

    if (!state) {
      return ctx.throw(401, 'account gone');
    }

    ctx.body = StateSchema.parse(state);
  },
);

router.post('/token', acceptValidator('application/json'), async (ctx) => {
  let body;

  try {
    body = TokenBodySchema.parse(ctx.request.body);
  } catch (err) {
    return ctx.throw(400, err as Error);
  }

  const parsed = parseWatchToken(body.token);

  if (!parsed) {
    return ctx.throw(404, 'invalid token');
  }

  const { userId, target, targetId } = parsed;

  // The account first: one merged away or deleted since the email went out
  // makes the link invalid, whatever became of its target.
  let state = await watchState(pool, userId, target, targetId);

  if (!state) {
    return ctx.throw(404, 'invalid token');
  }

  if (!(await targetExists(pool, target, targetId))) {
    return ctx.throw(410, 'no such event or photo');
  }

  if (body.watching !== undefined) {
    state = {
      ...state,
      ...(await setWatch(pool, userId, target, targetId, body.watching)),
    };
  }

  ctx.body = TokenResponseSchema.parse({
    target,
    targetId,
    title: await targetTitle(target, targetId),
    watching: state.watching,
  });
});

router.post('/unsubscribe', async (ctx) => {
  const token = ctx.query['token'];

  const parsed = typeof token === 'string' ? parseWatchToken(token) : null;

  if (!parsed) {
    return ctx.throw(404, 'invalid token');
  }

  // A genuine token always succeeds, so the provider doesn't retry: with its
  // account or target gone, nothing mails about it anyway.
  if (await targetExists(pool, parsed.target, parsed.targetId)) {
    await setWatch(pool, parsed.userId, parsed.target, parsed.targetId, false);
  }

  ctx.status = 204;
});

export const mailWatchRouter = router;
