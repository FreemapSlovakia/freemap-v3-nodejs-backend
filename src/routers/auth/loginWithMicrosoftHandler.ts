import got from 'got';
import z from 'zod';
import { getEnv } from '../../env.js';
import { makeOAuthLoginHandler } from './makeOAuthLoginHandler.js';

const clientId = getEnv('MICROSOFT_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('MICROSOFT_OAUTH2_CLIENT_SECRET');

// `common` accepts both personal Microsoft accounts and work/school accounts.
const SCOPE = 'openid profile email User.Read';

const TokenSchema = z.object({ access_token: z.string() });

const UserSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  mail: z.email().nullish(),
  userPrincipalName: z.string().nullish(),
});

export const attachLoginWithMicrosoftHandler = makeOAuthLoginHandler({
  provider: 'microsoft',
  path: '/login-microsoft',
  summary: 'Complete Microsoft OAuth login',
  clientId,
  async resolveProfile({ code, redirectUri }) {
    const token = TokenSchema.parse(
      await got
        .post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          form: {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            scope: SCOPE,
          },
        })
        .json(),
    );

    const user = UserSchema.parse(
      await got
        .get('https://graph.microsoft.com/v1.0/me', {
          headers: { authorization: `Bearer ${token.access_token}` },
        })
        .json(),
    );

    // Work/school accounts expose `mail`; personal accounts fall back to the
    // user principal name (which is an email address for personal accounts).
    const email =
      user.mail ??
      (user.userPrincipalName?.includes('@') ? user.userPrincipalName : null);

    return {
      remoteUserId: user.id,
      name: user.displayName ?? undefined,
      email,
      // Microsoft Graph only serves the photo as binary, not a URL.
      pictureUrl: null,
    };
  },
});
