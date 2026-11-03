import type { Logger } from 'pino';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from './database.js';
import { getEnv } from './env.js';

export const OSM_API_BASE = 'https://api.openstreetmap.org/api/0.6';

/** OSM's API usage policy asks every client to identify itself. */
export const OSM_USER_AGENT = 'Freemap (https://www.freemap.sk/)';

export const OSM_TIMEOUT_MS = 30_000;

export const OSM_CLIENT_ID = getEnv('OSM_OAUTH2_CLIENT_ID');

export const OSM_CLIENT_SECRET = getEnv('OSM_OAUTH2_CLIENT_SECRET');

const OsmUserDetailsSchema = z.object({
  user: z.object({
    id: z.uint32(),
    display_name: z.string(),
    home: z.object({ lat: z.number(), lon: z.number() }).optional(),
    img: z.object({ href: z.url() }).optional(),
  }),
});

export type OsmUser = z.infer<typeof OsmUserDetailsSchema>['user'];

export class OsmHttpError extends Error {
  constructor(readonly status: number) {
    super(`OSM answered HTTP ${status}`);

    this.name = 'OsmHttpError';
  }
}

/** The token owner's details; an `OsmHttpError` carries a non-OK status. */
export async function fetchOsmUser(
  token: string,
  timeoutMs = OSM_TIMEOUT_MS,
): Promise<OsmUser> {
  const response = await fetch(`${OSM_API_BASE}/user/details`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': OSM_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    await response.body?.cancel();

    throw new OsmHttpError(response.status);
  }

  return OsmUserDetailsSchema.parse(await response.json()).user;
}

async function revokeOsmToken(token: string): Promise<void> {
  const response = await fetch('https://www.openstreetmap.org/oauth2/revoke', {
    method: 'POST',
    headers: { 'user-agent': OSM_USER_AGENT },
    body: new URLSearchParams({
      token,
      client_id: OSM_CLIENT_ID,
      client_secret: OSM_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(OSM_TIMEOUT_MS),
  });

  await response.body?.cancel();

  if (!response.ok) {
    throw new OsmHttpError(response.status);
  }
}

/**
 * Revokes a token Freemap stops holding (RFC 7009), so no copy of it can still
 * upload traces. In the background: a failure only leaves it to expire at OSM.
 */
export function revokeOsmTokenLater(token: string, log: Logger): void {
  revokeOsmToken(token).catch((err) => {
    log.warn({ err }, 'Failed to revoke an OSM token.');
  });
}

/**
 * The same for a token that may be stored after all: a commit can succeed
 * though the client saw it fail, and OSM may hand back a token it issued before.
 */
export function revokeOsmTokenIfUnheld(token: string, log: Logger): void {
  pool
    .query<unknown[]>(
      sql`SELECT 1 FROM user WHERE osmAccessToken = ${token} LIMIT 1`,
    )
    .then((rows) => {
      if (rows.length === 0) {
        revokeOsmTokenLater(token, log);
      }
    })
    .catch((err) => {
      log.warn({ err }, 'Failed to check an OSM token before revoking it.');
    });
}
