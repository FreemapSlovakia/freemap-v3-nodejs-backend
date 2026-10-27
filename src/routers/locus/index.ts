import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Router from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import {
  APP_TOKEN_PREFIX,
  type AppTokenScope,
  generateAppToken,
  hashAppToken,
} from '../../appTokens.js';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { actionsXml, providersXml } from './providers.js';

// Every install of a user carries the same token, found by this note.
const TOKEN_NOTE = 'Locus Map';

const TOKEN_SCOPES = JSON.stringify([
  'tiles:outdoor',
  'tiles:shading',
  'tiles:aerial',
] satisfies AppTokenScope[]);

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
      'Create a Locus Map install link carrying the user\'s "Locus Map" app token',
    tags: ['locus'],
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
    tags: ['locus'],
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
    tags: ['locus'],
    requestParams: { path: NonceParamsSchema },
    responses: { 200: { content: { 'application/xml': {} } }, 404: {} },
  },
});

/** Derived from the row id, so a reinstall can hand out the token again while only its hash is stored. */
function locusToken(appTokenId: number) {
  // the ids are sequential, so the secret is the token's only entropy
  const secret = getEnv('LOCUS_TOKEN_SECRET', '');

  if (secret.length < 32) {
    throw new Error('LOCUS_TOKEN_SECRET must have at least 32 characters');
  }

  return (
    APP_TOKEN_PREFIX +
    createHmac('sha256', secret)
      .update(`locus:${appTokenId}`)
      .digest('base64url')
  );
}

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
    tags: ['locus'],
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
      'Locus online-map providers with the user\'s "Locus Map" app token, created on first use; uses up the install link',
    tags: ['locus'],
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

      // serializes concurrent installs of one user, which would each insert a token
      await conn.query(
        sql`SELECT 1 FROM user WHERE id = ${install.userId} FOR UPDATE`,
      );

      const candidates = await conn.query<{ id: number; tokenHash: Buffer }[]>(
        sql`
          SELECT id, tokenHash FROM appToken
            WHERE userId = ${install.userId}
              AND note COLLATE utf8mb4_bin = ${TOKEN_NOTE}
              AND (expiresAt IS NULL OR expiresAt > NOW())
        `,
      );

      // a token of that note the user made by hand doesn't match the derived hash
      const reused = candidates.find(({ id, tokenHash }) =>
        hashAppToken(locusToken(id)).equals(tokenHash),
      );

      if (reused) {
        await conn.query(
          sql`UPDATE appToken SET scopes = ${TOKEN_SCOPES} WHERE id = ${reused.id}`,
        );

        return locusToken(reused.id);
      }

      // the hash needs the id, so insert under a throwaway one first
      const { insertId } = await conn.query<{ insertId: number }>(sql`
        INSERT INTO appToken SET
          userId = ${install.userId},
          tokenHash = ${hashAppToken(generateAppToken())},
          note = ${TOKEN_NOTE},
          scopes = ${TOKEN_SCOPES}
      `);

      const token = locusToken(insertId);

      await conn.query(
        sql`UPDATE appToken SET tokenHash = ${hashAppToken(token)} WHERE id = ${insertId}`,
      );

      return token;
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
