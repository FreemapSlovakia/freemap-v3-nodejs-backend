import { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

type AtLeastOne<T> = { [K in keyof T]: Required<Pick<T, K>> }[keyof T] &
  Partial<T>;

export type Body = AtLeastOne<{
  name: string;
  email: (string & tags.Format<'email'>) | null;
  lat: number;
  lon: number;
  settings: Record<string, unknown>;
  sendGalleryEmails: boolean | null;
  language: (string & tags.MinLength<2> & tags.MaxLength<2>) | null;
}>;

export function attachPatchUserHandler(router: RouterInstance) {
  router.patch('/settings', authenticator(true), async (ctx) => {
    let body;

    try {
      body = assert<Body>(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const keys = Object.keys(body) as (keyof Body)[];

    // TODO validate duplicates

    await pool.query(
      sql`UPDATE user SET ${join(
        keys.map(
          (key) =>
            sql`${raw(key)} = ${key === 'settings' ? JSON.stringify(body[key]) : body[key]}`,
        ),
      )} WHERE id = ${ctx.state.user!.id}`,
    );

    ctx.status = 204;
  });
}
