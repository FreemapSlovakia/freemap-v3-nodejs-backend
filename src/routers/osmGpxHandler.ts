import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../authenticator.js';
import { pool } from '../database.js';
import type { User } from '../koaTypes.js';
import { AUTH_REQUIRED, registerPath } from '../openapi.js';
import {
  fetchOsmUser,
  OSM_API_BASE,
  OSM_TIMEOUT_MS,
  OSM_USER_AGENT,
  OsmHttpError,
} from '../osm.js';
import { acceptValidator } from '../requestValidators.js';

const BodySchema = z.strictObject({
  gpx: z.string().nonempty(),
  description: z.string().trim().nonempty().max(255),
  // OSM takes them as one comma-separated string and refuses `. ; / ? % #`
  // in one.
  tags: z
    .array(
      z
        .string()
        .trim()
        .nonempty()
        .max(255)
        .refine(
          (tag) => !/[,.;/?%#]/.test(tag),
          'A tag must not contain , . ; / ? % or #',
        ),
    )
    .optional(),
  visibility: z.enum(['private', 'public', 'trackable', 'identifiable']),
});

/** Short: the client waits for it with the form disabled. */
const CHECK_TIMEOUT_MS = 5000;

/**
 * Forgets a token OSM rejects, so the client asks for authorization again —
 * only that token, as a new one may have been granted meanwhile.
 */
async function forgetToken(user: User, token: string) {
  await pool.query<unknown>(
    sql`UPDATE user SET osmAccessToken = NULL
      WHERE id = ${user.id} AND osmAccessToken = ${token}`,
  );
}

/** OSM's reason for refusing a trace, fit for a toast; not an HTML error page. */
function rejectionReason(response: Response, text: string): string {
  return response.headers.get('content-type')?.startsWith('text/plain') &&
    text.length <= 500
    ? text
    : `OpenStreetMap refused the trace (HTTP ${response.status}).`;
}

export function attachOsmGpxHandlers(router: RouterInstance) {
  registerPath('/osm-gpx/authorization', {
    get: {
      summary:
        'Check with OpenStreetMap that the stored GPS trace upload token is still valid',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.strictObject({
                authorized: z
                  .boolean()
                  .nullable()
                  .meta({ description: 'null when OSM gave no clear answer' }),
              }),
            },
          },
        },
        401: {},
      },
    },
  });

  router.get('/osm-gpx/authorization', authenticator(true), async (ctx) => {
    const user = ctx.state.user!;

    if (!user.osmAccessToken) {
      ctx.body = { authorized: false };

      return;
    }

    try {
      await fetchOsmUser(user.osmAccessToken, CHECK_TIMEOUT_MS);
    } catch (err) {
      // 401 is a revoked token; any other failure says nothing about it.
      if (err instanceof OsmHttpError && err.status === 401) {
        await forgetToken(user, user.osmAccessToken);

        ctx.body = { authorized: false };
      } else {
        ctx.log.warn({ err }, 'OSM authorization check failed.');

        ctx.body = { authorized: null };
      }

      return;
    }

    ctx.body = { authorized: true };
  });

  registerPath('/osm-gpx', {
    post: {
      summary: 'Upload a GPS trace to OpenStreetMap',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.strictObject({ id: z.uint32(), url: z.url() }),
            },
          },
        },
        400: {},
        401: {},
        403: { description: 'No OSM token with the write_gpx scope' },
      },
    },
  });

  router.post(
    '/osm-gpx',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const user = ctx.state.user!;

      if (!user.osmAccessToken) {
        return ctx.throw(403, 'osm not authorized');
      }

      const form = new FormData();

      form.append(
        'file',
        new Blob([body.gpx], { type: 'application/gpx+xml' }),
        'freemap.gpx',
      );

      form.append('description', body.description);

      // OSM splits a string without a comma on spaces, so a lone
      // "mountain bike" would become two tags; the trailing comma prevents it.
      form.append('tags', body.tags?.length ? `${body.tags.join(',')},` : '');

      form.append('visibility', body.visibility);

      // In parallel; it doesn't depend on the upload.
      // The trace's page is addressed by the owner's current display name.
      const displayName = fetchOsmUser(user.osmAccessToken).then(
        (osmUser) => osmUser.display_name,
      );

      displayName.catch(() => {
        // Unobserved when the upload fails; awaited below otherwise.
      });

      const response = await fetch(`${OSM_API_BASE}/gpx`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${user.osmAccessToken}`,
          'user-agent': OSM_USER_AGENT,
        },
        body: form,
        signal: AbortSignal.timeout(OSM_TIMEOUT_MS),
      });

      if (response.status === 401) {
        await response.body?.cancel();

        await forgetToken(user, user.osmAccessToken);

        return ctx.throw(403, 'osm not authorized');
      }

      const text = await response.text();

      // The trace itself, or an account OSM won't take traces from (403, e.g.
      // blocked): authorizing again can't fix either.
      if (response.status >= 400 && response.status < 500) {
        return ctx.throw(400, rejectionReason(response, text));
      }

      if (!response.ok) {
        throw new Error(
          `Error uploading GPX to OSM: ${response.status} ${text}`,
        );
      }

      if (!/^\d+$/.test(text.trim())) {
        throw new Error(`Unexpected OSM GPX upload response: ${text}`);
      }

      const id = Number(text.trim());

      let url;

      try {
        url = `https://www.openstreetmap.org/user/${encodeURIComponent(await displayName)}/traces/${id}`;
      } catch (err) {
        // The trace exists, so this only costs the link its precision.
        ctx.log.warn({ err }, 'Failed to resolve the OSM display name.');

        url = 'https://www.openstreetmap.org/traces/mine';
      }

      ctx.body = { id, url };
    },
  );
}
