import type { RouterInstance } from '@koa/router';
import got, { HTTPError, RequestError } from 'got';
import type { ParameterizedContext } from 'koa';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import {
  FacebookKeysUnavailable,
  InvalidLimitedLoginToken,
  isLimitedLoginToken,
  verifyLimitedLoginToken,
} from '../../facebookLimitedLogin.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { checkTokenAudience } from '../../tokenAudience.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const FacebookUserSchema = z.object({
  id: z.string().nonempty(),
  name: z.string(),
  email: z.email().nullish(),
  picture: z
    .object({
      data: z.object({
        url: z.url().optional(),
        is_silhouette: z.boolean().optional(),
      }),
    })
    .nullish(),
});

type FacebookUser = {
  id: string;
  name: string | undefined;
  email: string | null;
  pictureUrl: string | null;
};

const AppSchema = z.object({ id: z.string().nonempty() });

/** A classic access token: Graph says whose it is, and for which app. */
async function graphUser(
  ctx: ParameterizedContext,
  accessToken: string,
): Promise<FacebookUser> {
  // In a header, not the query string: got puts the URL into its HTTPError
  // message, which put the user's whole token into Sentry.
  const graph = (path: string) =>
    got(`https://graph.facebook.com/v20.0/${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }).json();

  const [user, app] = await Promise.allSettled([
    graph('me?fields=id,name,email,picture.width(256).height(256)').then(
      (body) => FacebookUserSchema.parse(body),
    ),
    // The app the token was issued to: else a token any other app got from
    // the user would log in here as them.
    graph('app?fields=id').then((body) => AppSchema.parse(body)),
  ]);

  // Both settled, so a refused token is a 401 whichever answer came first.
  // 4xx: Facebook refuses the token — expired or revoked. Anything else is
  // Facebook failing or unreachable. Either way not our 500.
  const failures = [user, app].flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );

  if (
    failures.some(
      (err) =>
        err instanceof HTTPError &&
        err.response.statusCode >= 400 &&
        err.response.statusCode < 500,
    )
  ) {
    return ctx.throw(401, 'invalid Facebook token');
  }

  for (const err of failures) {
    if (err instanceof HTTPError || err instanceof RequestError) {
      return ctx.throw(502, 'Facebook unavailable');
    }
  }

  if (user.status === 'rejected') {
    throw user.reason;
  }

  if (app.status === 'rejected') {
    throw app.reason;
  }

  checkTokenAudience(ctx, 'facebook', [app.value.id]);

  const { id, name, email, picture } = user.value;

  return {
    id,
    name,
    email: email ?? null,
    pictureUrl: picture?.data.is_silhouette
      ? null
      : (picture?.data.url ?? null),
  };
}

/**
 * A Limited Login token, which the iOS SDK hands out when the user has not
 * allowed tracking. Graph refuses it; it is a JWT carrying the user's details,
 * verified here against Facebook's keys.
 */
async function limitedLoginUser(
  ctx: ParameterizedContext,
  token: string,
): Promise<FacebookUser> {
  let claims;

  try {
    claims = await verifyLimitedLoginToken(token);
  } catch (err) {
    if (err instanceof InvalidLimitedLoginToken) {
      ctx.log.info({ reason: err.message }, 'Invalid Limited Login token.');

      return ctx.throw(401, 'invalid Facebook token');
    }

    if (err instanceof FacebookKeysUnavailable) {
      ctx.log.warn({ err }, 'Facebook signing keys unavailable.');

      return ctx.throw(502, 'Facebook unavailable');
    }

    throw err; // a bug: a 500, for Sentry
  }

  // Signed by Facebook for *some* app: only ours may log in here.
  checkTokenAudience(
    ctx,
    'facebook',
    typeof claims.aud === 'string' ? [claims.aud] : claims.aud,
  );

  return {
    id: claims.sub,
    name: claims.name,
    email: claims.email ?? null,
    pictureUrl: claims.picture ?? null,
  };
}

const BodySchema = z.strictObject({
  // A Graph access token, or a Limited Login JWT (the iOS app)
  accessToken: z.string().nonempty(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
});

export function attachLoginWithFacebookHandler(router: RouterInstance) {
  registerPath('/auth/login-fb', {
    post: {
      summary: 'Log in with Facebook OAuth',
      description:
        '`accessToken` is a Graph access token, or a Limited Login ' +
        'authentication token (JWT).',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: {
          content: { 'application/json': { schema: LoginResponseSchema } },
        },
        400: {},
        401: {
          description: 'Facebook refused the token, or it is for another app',
        },
        409: {
          description: 'A different remote account than the connected one',
        },
        502: { description: 'Facebook failed or is unreachable' },
      },
    },
  });

  router.post('/login-fb', authenticator(false), async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const { accessToken, language, connect } = body;

    const { id, name, email, pictureUrl } = isLimitedLoginToken(accessToken)
      ? await limitedLoginUser(ctx, accessToken)
      : await graphUser(ctx, accessToken);

    await login(
      ctx,
      'facebook',
      id,
      name,
      email,
      undefined,
      undefined,
      language,
      connect,
      { remotePictureUrl: pictureUrl },
    );
  });
}
