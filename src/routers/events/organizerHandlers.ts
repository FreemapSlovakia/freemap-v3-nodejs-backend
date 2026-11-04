import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { fetchAndProcessProfilePicture } from '../../profilePicture.js';
import { acceptValidator } from '../../requestValidators.js';
import { hasRole } from '../../roles.js';

export const OrganizerSchema = z
  .strictObject({ id: z.uint32(), name: z.string() })
  .meta({ id: 'EventOrganizer' });

const BodySchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  /** A logo to fetch as the account's picture, e.g. from the club's website. */
  pictureUrl: z.url({ protocol: /^https?$/ }).optional(),
});

export function attachOrganizerHandlers(router: RouterInstance) {
  registerPath('/events/organizers', {
    post: {
      summary:
        'Create an organizer account with no login, to enter events for (eventManager only)',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: OrganizerSchema } } },
        400: {},
        401: {},
        403: {},
      },
    },
  });

  router.post(
    '/organizers',
    acceptValidator('application/json'),
    authenticator(true, 'events:write'),
    async (ctx) => {
      if (!hasRole(ctx.state.user, 'eventManager')) {
        return ctx.throw(403);
      }

      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      // An unreadable logo leaves the account without a picture.
      const picture = body.pictureUrl
        ? await fetchAndProcessProfilePicture(body.pictureUrl, 'contain')
        : null;

      const { insertId } = await pool.query<{ insertId: number }>(
        // No login provider: handed over to the real person by a merge.
        sql`INSERT INTO user SET name = ${body.name}, picture = ${picture}`,
      );

      ctx.body = OrganizerSchema.parse({ id: insertId, name: body.name });
    },
  );
}

/**
 * Throws unless the caller may make `ownerId` the event's owner: themselves,
 * or as an eventManager any existing user — the organizer's own account, or
 * one with no login made for them.
 */
export async function assertCanOwn(
  ctx: ParameterizedContext,
  conn: PoolConnection,
  ownerId: number,
) {
  const { user } = ctx.state;

  if (ownerId === user?.id) {
    return;
  }

  if (!hasRole(user, 'eventManager')) {
    ctx.throw(403, 'only an eventManager can enter an event for someone else');
  }

  const [row] = await conn.query<{ id: number }[]>(
    sql`SELECT id FROM user WHERE id = ${ownerId}`,
  );

  if (!row) {
    ctx.throw(404, 'no such user');
  }
}
