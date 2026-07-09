import got from 'got';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from './database.js';
import { getEnv } from './env.js';
import type { User } from './koaTypes.js';

const clientId = getEnv('STRAVA_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('STRAVA_OAUTH2_CLIENT_SECRET');

export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

// Refresh once the access token is within this window of expiring, so a call
// made right after the check still has a valid token.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const RefreshSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
});

export class StravaNotConnectedError extends Error {
  constructor() {
    super('Strava account is not connected');
    this.name = 'StravaNotConnectedError';
  }
}

/**
 * Returns a valid Strava access token for the user, refreshing and persisting
 * it when the stored one is missing or about to expire. Strava rotates the
 * refresh token on every refresh, so the new one is stored too.
 *
 * Mutates the passed `user` in place so callers holding `ctx.state.user` see
 * the fresh token within the same request.
 */
export async function getValidStravaAccessToken(user: User): Promise<string> {
  if (!user.stravaRefreshToken) {
    throw new StravaNotConnectedError();
  }

  const expiresAt = user.stravaTokenExpiresAt?.getTime() ?? 0;

  if (user.stravaAccessToken && expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return user.stravaAccessToken;
  }

  const { access_token, refresh_token, expires_at } = RefreshSchema.parse(
    await got
      .post('https://www.strava.com/oauth/token', {
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: user.stravaRefreshToken,
        },
      })
      .json(),
  );

  const newExpiresAt = new Date(expires_at * 1000);

  await pool.query<unknown>(sql`UPDATE user SET
    stravaAccessToken = ${access_token},
    stravaRefreshToken = ${refresh_token},
    stravaTokenExpiresAt = ${newExpiresAt}
    WHERE id = ${user.id}`);

  user.stravaAccessToken = access_token;
  user.stravaRefreshToken = refresh_token;
  user.stravaTokenExpiresAt = newExpiresAt;

  return access_token;
}
