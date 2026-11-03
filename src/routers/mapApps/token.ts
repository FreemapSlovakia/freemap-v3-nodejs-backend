import { createHmac } from 'node:crypto';
import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import {
  APP_TOKEN_PREFIX,
  type AppTokenScope,
  generateAppToken,
  hashAppToken,
} from '../../appTokens.js';
import { getEnv } from '../../env.js';

// Every map app of a user carries the same token, found by this note.
const TOKEN_NOTE = 'Map apps';

const TOKEN_SCOPES = JSON.stringify([
  'tiles:outdoor',
  'tiles:shading',
  'tiles:aerial',
] satisfies AppTokenScope[]);

/** Derived from the row id, so it can be handed out again while only its hash is stored. */
function derivedToken(appTokenId: number) {
  // the ids are sequential, so the secret is the token's only entropy
  const secret = getEnv('LOCUS_TOKEN_SECRET', '');

  if (secret.length < 32) {
    throw new Error('LOCUS_TOKEN_SECRET must have at least 32 characters');
  }

  return (
    APP_TOKEN_PREFIX +
    createHmac('sha256', secret)
      // part of every token already issued: changing it orphans them
      .update(`locus:${appTokenId}`)
      .digest('base64url')
  );
}

/** The user's map-apps token, created on first use; call within a transaction. */
export async function mapAppsToken(conn: PoolConnection, userId: number) {
  // serializes concurrent requests of one user, which would each insert a token
  await conn.query(sql`SELECT 1 FROM user WHERE id = ${userId} FOR UPDATE`);

  const candidates = await conn.query<{ id: number; tokenHash: Buffer }[]>(sql`
    SELECT id, tokenHash FROM appToken
      WHERE userId = ${userId}
        AND note COLLATE utf8mb4_bin = ${TOKEN_NOTE}
        AND (expiresAt IS NULL OR expiresAt > NOW())
  `);

  // a token of that note the user made by hand doesn't match the derived hash
  const reused = candidates.find(({ id, tokenHash }) =>
    hashAppToken(derivedToken(id)).equals(tokenHash),
  );

  if (reused) {
    await conn.query(
      sql`UPDATE appToken SET scopes = ${TOKEN_SCOPES} WHERE id = ${reused.id}`,
    );

    return derivedToken(reused.id);
  }

  // the hash needs the id, so insert under a throwaway one first
  const { insertId } = await conn.query<{ insertId: number }>(sql`
    INSERT INTO appToken SET
      userId = ${userId},
      tokenHash = ${hashAppToken(generateAppToken())},
      note = ${TOKEN_NOTE},
      scopes = ${TOKEN_SCOPES}
  `);

  const token = derivedToken(insertId);

  await conn.query(
    sql`UPDATE appToken SET tokenHash = ${hashAppToken(token)} WHERE id = ${insertId}`,
  );

  return token;
}
