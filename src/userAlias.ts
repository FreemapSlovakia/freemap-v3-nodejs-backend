import type { ParameterizedContext } from 'koa';
import sql, { join } from 'sql-template-tag';
import { pool } from './database.js';

/**
 * For a user ID with no account: redirects to the one it was merged into, by
 * replacing it in the request path. Returns whether it did.
 */
export async function redirectMergedUser(
  ctx: ParameterizedContext,
  id: number,
): Promise<boolean> {
  const [alias] = await pool.query<{ userId: number }[]>(
    sql`SELECT userId FROM userAlias WHERE oldId = ${id}`,
  );

  if (!alias) {
    return false;
  }

  ctx.redirect(
    ctx.originalUrl.replace(`/users/${id}/`, `/users/${alias.userId}/`),
  );

  return true;
}

/**
 * The IDs with those merged away replaced by the ones they went into. Resolved
 * apart from the query using them: inline, `OR userId IN (…)` loses its index.
 */
export async function withMergedUsers(ids: number[]): Promise<number[]> {
  if (ids.length === 0) {
    return ids;
  }

  const aliases = await pool.query<{ userId: number }[]>(
    sql`SELECT userId FROM userAlias WHERE oldId IN (${join(ids)})`,
  );

  return [...new Set([...ids, ...aliases.map((a) => a.userId)])];
}
