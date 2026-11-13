import {
  createRemoteJWKSet,
  errors,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import z from 'zod';

// Facebook's signing keys, as its OIDC configuration
// (https://limited.facebook.com/.well-known/openid-configuration/) names them.
// Fetched on first use and cached by jose; a token signed with a key not in
// the cache (rotation) refetches at once. Kept a day rather than jose's 10
// minutes, so a blip at Facebook's end fails no login while the keys hold.
const facebookKeys = createRemoteJWKSet(
  new URL('https://www.facebook.com/.well-known/oauth/openid/jwks/'),
  { cacheMaxAge: 24 * 60 * 60 * 1000 },
);

const ISSUER = 'https://www.facebook.com';

/**
 * What a Limited Login token says about the user. `sub` is the app-scoped
 * user ID — the same one Graph's `/me` answers with, so an account made
 * through either login is found through the other.
 */
const ClaimsSchema = z.object({
  sub: z.string().nonempty(),
  aud: z.union([z.string(), z.array(z.string())]),
  name: z.string().optional(),
  // An address or URL zod finds odd costs that detail, not the whole login.
  email: z.email().optional().catch(undefined),
  picture: z.url().optional().catch(undefined),
});

export type LimitedLoginClaims = z.infer<typeof ClaimsSchema>;

/**
 * Whether a token from the client is a Limited Login one. The iOS SDK hands
 * out such a JWT instead of a Graph access token when the user has not
 * allowed tracking; a classic access token has no dots, so cannot pass.
 */
export function isLimitedLoginToken(token: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token);
}

/** Thrown for a token that is not a valid Limited Login token of Facebook's. */
export class InvalidLimitedLoginToken extends Error {}

/** Thrown when Facebook's signing keys cannot be had: Facebook's failure. */
export class FacebookKeysUnavailable extends Error {}

/**
 * The key getter, with every failure to get the keys marked as Facebook's —
 * whatever jose or fetch throws for it (a non-200 answer, bad JSON, a timeout,
 * no network). Only "no key for this token" stays the token's fault.
 */
function guarded(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await keys(header, token);
    } catch (err) {
      if (
        err instanceof errors.JWKSNoMatchingKey ||
        err instanceof errors.JWKSMultipleMatchingKeys
      ) {
        throw err;
      }

      throw new FacebookKeysUnavailable('Facebook signing keys unavailable', {
        cause: err,
      });
    }
  };
}

/**
 * Verifies a Limited Login token — Facebook's signature, issuer and expiry —
 * and returns its claims. The audience is left to the caller, as for Apple's
 * tokens, so a foreign one can be logged by `checkTokenAudience`.
 *
 * Throws `InvalidLimitedLoginToken` for a bad token and
 * `FacebookKeysUnavailable` when the keys cannot be fetched. Anything else is
 * a bug, and passes as it is.
 */
export async function verifyLimitedLoginToken(
  token: string,
  keys: JWTVerifyGetKey = facebookKeys,
): Promise<LimitedLoginClaims> {
  let payload;

  try {
    ({ payload } = await jwtVerify(token, guarded(keys), {
      issuer: ISSUER,
      algorithms: ['RS256'],
    }));
  } catch (err) {
    // Past the key getter, a jose error is about the token (bad signature,
    // expired, wrong issuer, unknown key, malformed, …).
    if (err instanceof errors.JOSEError) {
      throw new InvalidLimitedLoginToken(err.message, { cause: err });
    }

    throw err;
  }

  const claims = ClaimsSchema.safeParse(payload);

  if (!claims.success) {
    throw new InvalidLimitedLoginToken('unexpected Limited Login claims', {
      cause: claims.error,
    });
  }

  return claims.data;
}
