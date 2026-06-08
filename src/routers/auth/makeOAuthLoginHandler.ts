import { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator, authProviderToColumn } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LoginResponseSchema } from '../../types.js';
import { login } from './loginProcessor.js';

export type OAuthProfile = {
  remoteUserId: string | number;
  name?: string;
  email?: string | null;
  lat?: number;
  lon?: number;
  pictureUrl?: string | null;
};

const BodySchema = z.strictObject({
  code: z.string().nonempty(),
  language: z.string().nullable(),
  connect: z.boolean().optional(),
  redirectUri: z.url(),
});

/**
 * Builds an attach function for an OAuth2 authorization-code provider.
 *
 * The flow mirrors `loginWithOsmHandler`: a `GET` returns the public client ID
 * so the client can open the provider's authorize popup, and a `POST` receives
 * the resulting `code`, which `resolveProfile` exchanges for a token and the
 * user's profile before delegating to the shared `login` processor.
 */
export function makeOAuthLoginHandler(opts: {
  provider: keyof typeof authProviderToColumn;
  path: `/${string}`;
  summary: string;
  clientId: string;
  resolveProfile: (params: {
    code: string;
    redirectUri: string;
    connect?: boolean;
  }) => Promise<OAuthProfile>;
}) {
  return function attach(router: RouterInstance) {
    registerPath(`/auth${opts.path}`, {
      get: {
        summary: `Get ${opts.provider} OAuth client ID to initiate login`,
        tags: ['auth'],
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.strictObject({ clientId: z.string() }),
              },
            },
          },
        },
      },
      post: {
        summary: opts.summary,
        tags: ['auth'],
        security: AUTH_OPTIONAL,
        requestBody: {
          content: { 'application/json': { schema: BodySchema } },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: LoginResponseSchema } },
          },
          400: {},
        },
      },
    });

    router.get(opts.path, (ctx) => {
      ctx.body = { clientId: opts.clientId };
    });

    router.post(
      opts.path,
      authenticator(false),
      acceptValidator('application/json'),
      async (ctx) => {
        let body;

        try {
          body = BodySchema.parse(ctx.request.body);
        } catch (err) {
          ctx.log.warn({ body: ctx.request.body }, 'Invalid body.');

          return ctx.throw(400, err as Error);
        }

        const { code, language, connect, redirectUri } = body;

        const profile = await opts.resolveProfile({
          code,
          redirectUri,
          connect,
        });

        await login(
          ctx,
          opts.provider,
          profile.remoteUserId,
          profile.name,
          profile.email ?? null,
          profile.lat,
          profile.lon,
          language,
          connect,
          undefined,
          undefined,
          profile.pictureUrl ?? null,
        );
      },
    );
  };
}
