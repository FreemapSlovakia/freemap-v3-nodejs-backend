import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Router from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { actionsXml, providersXml } from './locus.js';
import { onlineMapSourcesXml } from './orux.js';
import { mapAppsToken } from './token.js';

const baseUrl = `${getEnv('API_URL', 'https://backend.freemap.sk')}/locus`;

const icon = readFileSync(new URL('./Freemap.png', import.meta.url));

const InstallResponseSchema = z.strictObject({
  url: z
    .string()
    .meta({ description: 'locus-actions: link, single use, valid 10 minutes' }),
});

const NonceParamsSchema = z.object({
  nonce: z.string().regex(/^[\w-]{43}$/),
});

const router = new Router();

registerPath('/locus/installs', {
  post: {
    summary:
      'Create a Locus Map install link carrying the user\'s "Map apps" app token',
    tags: ['mapApps'],
    security: AUTH_REQUIRED,
    responses: {
      200: {
        content: { 'application/json': { schema: InstallResponseSchema } },
      },
      401: {},
    },
  },
});

router.post('/installs', authenticator(true), async (ctx) => {
  const nonce = randomBytes(32).toString('base64url');

  await pool.query(sql`
    INSERT INTO locusInstall SET
      nonce = ${nonce},
      userId = ${ctx.state.user!.id},
      expireAt = NOW() + INTERVAL 10 MINUTE
  `);

  ctx.body = InstallResponseSchema.parse({
    url: `locus-actions://${`${baseUrl}/install/${nonce}`.replace('://', '/')}`,
  });
});

registerPath('/locus/install', {
  get: {
    summary: 'Locus Actions file installing the maps without premium zooms',
    tags: ['mapApps'],
    responses: { 200: { content: { 'application/xml': {} } } },
  },
});

router.get('/install', (ctx) => {
  ctx.type = 'application/xml';
  ctx.body = actionsXml(`${baseUrl}/providers`, `${baseUrl}/Freemap.png`);
});

registerPath('/locus/install/{nonce}', {
  get: {
    summary: 'Locus Actions file installing the maps with an app token',
    tags: ['mapApps'],
    requestParams: { path: NonceParamsSchema },
    responses: { 200: { content: { 'application/xml': {} } }, 404: {} },
  },
});

function parseNonce(params: unknown) {
  return NonceParamsSchema.safeParse(params).data?.nonce;
}

router.get('/install/:nonce', async (ctx) => {
  const nonce = parseNonce(ctx.params);

  const [row] = nonce
    ? await pool.query<unknown[]>(
        sql`SELECT 1 FROM locusInstall WHERE nonce = ${nonce} AND expireAt > NOW()`,
      )
    : [];

  if (!row) {
    return ctx.throw(404, 'no such install link or it has expired');
  }

  ctx.type = 'application/xml';
  ctx.body = actionsXml(
    `${baseUrl}/providers/${nonce}`,
    `${baseUrl}/Freemap.png`,
  );
});

registerPath('/locus/providers', {
  get: {
    summary: 'Locus online-map providers without premium zooms',
    tags: ['mapApps'],
    responses: { 200: { content: { 'application/xml': {} } } },
  },
});

router.get('/providers', (ctx) => {
  ctx.type = 'application/xml';
  ctx.body = providersXml(null);
});

registerPath('/locus/providers/{nonce}', {
  get: {
    summary:
      'Locus online-map providers with the user\'s "Map apps" app token, created on first use; uses up the install link',
    tags: ['mapApps'],
    requestParams: { path: NonceParamsSchema },
    responses: { 200: { content: { 'application/xml': {} } }, 404: {} },
  },
});

router.get('/providers/:nonce', async (ctx) => {
  const nonce = parseNonce(ctx.params);

  // the router answers HEAD with this handler too; it must not use up the link
  if (ctx.method === 'HEAD') {
    ctx.type = 'application/xml';
    ctx.status = 200;

    return;
  }

  const token =
    nonce &&
    (await runInTransaction(async (conn) => {
      const [install] = await conn.query<{ userId: number }[]>(sql`
        SELECT userId FROM locusInstall
          WHERE nonce = ${nonce} AND expireAt > NOW()
          FOR UPDATE
      `);

      if (!install) {
        return null;
      }

      await conn.query(sql`DELETE FROM locusInstall WHERE nonce = ${nonce}`);

      return mapAppsToken(conn, install.userId);
    }));

  if (!token) {
    return ctx.throw(404, 'no such install link or it has expired');
  }

  ctx.type = 'application/xml';
  ctx.set('Cache-Control', 'no-store');
  ctx.body = providersXml(token);
});

router.get('/Freemap.png', (ctx) => {
  ctx.type = 'image/png';
  ctx.set('Cache-Control', 'public, max-age=86400');
  ctx.body = icon;
});

export const locusRouter = router;

export const oruxRouter = new Router();

registerPath('/oruxmaps/onlinemapsources.xml', {
  get: {
    summary:
      'OruxMaps online-map sources; logged in, with the user\'s "Map apps" app token, created on first use',
    tags: ['mapApps'],
    security: AUTH_OPTIONAL,
    responses: {
      200: { content: { 'application/xml': {} } },
      401: {},
      403: { description: 'app tokens may not mint the token' },
    },
  },
});

oruxRouter.get('/onlinemapsources.xml', authenticator(false), async (ctx) => {
  ctx.type = 'application/xml';
  ctx.attachment('onlinemapsources.xml');

  // a cached anonymous copy must not answer a later logged-in request
  ctx.set(
    'Cache-Control',
    ctx.get('Authorization') ? 'no-store' : 'public, max-age=3600',
  );

  // the router answers HEAD with this handler too; it must not mint a token
  if (ctx.method === 'HEAD') {
    ctx.status = 200;

    return;
  }

  const user = ctx.state.user;

  const token = user
    ? await runInTransaction((conn) => mapAppsToken(conn, user.id))
    : null;

  ctx.body = onlineMapSourcesXml(token);
});
