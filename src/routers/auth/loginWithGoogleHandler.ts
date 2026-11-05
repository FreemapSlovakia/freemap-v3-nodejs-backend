import type { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { checkTokenAudience } from '../../tokenAudience.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

const BodySchema = z.strictObject({
  accessToken: z.string().nonempty(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
});

const GoogleUserSchema = z.object({
  sub: z.string(),
  name: z.string().optional(),
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
  picture: z.url().optional(),
});

// `user_id` in place of `sub` for a token without the openid scope.
const TokeninfoSchema = z.object({
  sub: z.string().optional(),
  user_id: z.string().optional(),
  aud: z.string().optional(),
  azp: z.string().optional(),
});

export function attachLoginWithGoogleHandler(router: RouterInstance) {
  registerPath('/auth/login-google', {
    post: {
      summary: 'Log in with Google OAuth',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: {
          content: { 'application/json': { schema: LoginResponseSchema } },
        },
        400: {},
        409: {
          description: 'A different remote account than the connected one',
        },
      },
    },
  });

  router.post(
    '/login-google',
    authenticator(false),
    acceptValidator('application/json'),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        ctx.log.warn({ body }, 'Invalid body.');

        return ctx.throw(400, err as Error);
      }

      const { accessToken, language, connect } = body;

      // userinfo answers for a token of any app; tokeninfo says which app. It
      // is rate-limited, a debugging aid, so its failing in any way leaves the
      // app unknown (undefined) instead of failing the login.
      const [userinfoRes, tokeninfo] = await Promise.all([
        fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
        fetch(
          `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
        )
          .then(async (res) =>
            res.ok ? TokeninfoSchema.parse(await res.json()) : undefined,
          )
          .catch(() => undefined),
      ]);

      // 4xx: Google refuses the token; anything else is Google failing.
      if (!userinfoRes.ok) {
        return userinfoRes.status >= 400 && userinfoRes.status < 500
          ? ctx.throw(401, 'invalid Google token')
          : ctx.throw(502, 'Google unavailable');
      }

      const { sub, name, email, email_verified, picture } =
        GoogleUserSchema.parse(await userinfoRes.json());

      // Only the audience is what matters; an ID is compared when given.
      const tokenSub = tokeninfo?.sub ?? tokeninfo?.user_id;

      if (tokenSub !== undefined && tokenSub !== sub) {
        return ctx.throw(401, 'invalid Google token');
      }

      // Another app's token, or an unknown one (let through while not
      // enforced), proves no address.
      const ours = checkTokenAudience(
        ctx,
        'google',
        tokeninfo &&
          [tokeninfo.aud, tokeninfo.azp].filter((id) => id !== undefined),
      );

      // Default Google picture URL is 96px (=s96-c). Request 256 so the
      // 128x128 cover-resize doesn't upscale.
      const pictureUrl = picture
        ? picture.replace(/=s\d+(-c)?$/, '=s256-c')
        : null;

      await login(
        ctx,
        'google',
        sub,
        name,
        email,
        undefined,
        undefined,
        language,
        connect,
        {
          remotePictureUrl: pictureUrl,
          remoteEmailVerified: ours && email_verified === true,
        },
      );
    },
  );
}
