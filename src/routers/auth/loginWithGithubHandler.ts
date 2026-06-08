import got from 'got';
import z from 'zod';
import { getEnv } from '../../env.js';
import { makeOAuthLoginHandler } from './makeOAuthLoginHandler.js';

const clientId = getEnv('GITHUB_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('GITHUB_OAUTH2_CLIENT_SECRET');

const TokenSchema = z.object({ access_token: z.string() });

const UserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullish(),
  email: z.email().nullish(),
  avatar_url: z.url().nullish(),
});

const EmailsSchema = z.array(
  z.object({
    email: z.email(),
    primary: z.boolean(),
    verified: z.boolean(),
  }),
);

export const attachLoginWithGithubHandler = makeOAuthLoginHandler({
  provider: 'github',
  path: '/login-github',
  summary: 'Complete GitHub OAuth login',
  clientId,
  async resolveProfile({ code, redirectUri }) {
    const token = TokenSchema.parse(
      await got
        .post('https://github.com/login/oauth/access_token', {
          headers: { accept: 'application/json' },
          form: {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          },
        })
        .json(),
    );

    const headers = {
      authorization: `Bearer ${token.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'freemap',
    };

    const user = UserSchema.parse(
      await got.get('https://api.github.com/user', { headers }).json(),
    );

    let email = user.email ?? null;

    // The public profile email may be hidden; fall back to the verified
    // primary address (requires the `user:email` scope).
    if (!email) {
      const emails = EmailsSchema.parse(
        await got.get('https://api.github.com/user/emails', { headers }).json(),
      );

      email =
        emails.find((e) => e.primary && e.verified)?.email ??
        emails.find((e) => e.verified)?.email ??
        null;
    }

    return {
      remoteUserId: user.id,
      name: user.name ?? user.login,
      email,
      pictureUrl: user.avatar_url ?? null,
    };
  },
});
