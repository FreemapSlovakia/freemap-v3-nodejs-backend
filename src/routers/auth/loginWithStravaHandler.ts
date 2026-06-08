import got from 'got';
import z from 'zod';
import { getEnv } from '../../env.js';
import { makeOAuthLoginHandler } from './makeOAuthLoginHandler.js';

const clientId = getEnv('STRAVA_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('STRAVA_OAUTH2_CLIENT_SECRET');

// Strava returns the athlete inline with the token, so no extra fetch is
// needed. Strava does not expose an email address at all.
const TokenSchema = z.object({
  access_token: z.string(),
  athlete: z.object({
    id: z.number(),
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
    profile: z.string().nullish(),
  }),
});

export const attachLoginWithStravaHandler = makeOAuthLoginHandler({
  provider: 'strava',
  path: '/login-strava',
  summary: 'Complete Strava OAuth login',
  clientId,
  async resolveProfile({ code }) {
    const { athlete } = TokenSchema.parse(
      await got
        .post('https://www.strava.com/oauth/token', {
          form: {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
          },
        })
        .json(),
    );

    const name = [athlete.firstname, athlete.lastname]
      .filter(Boolean)
      .join(' ');

    return {
      remoteUserId: athlete.id,
      name: name || undefined,
      email: null,
      // `profile` is a URL, or a relative placeholder for the default avatar.
      pictureUrl: athlete.profile?.startsWith('http') ? athlete.profile : null,
    };
  },
});
