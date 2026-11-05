import type { ParameterizedContext } from 'koa';
import { getEnv, getEnvBoolean } from './env.js';

type Provider = 'google' | 'apple';

// A provider's token proves who signed in to *some* app. Only one issued to
// ours may log in: else any app the user signed in to could replay it here.
const config: Record<Provider, { audiences: Set<string>; enforce: boolean }> = {
  google: {
    // The web's client, and the Android app's.
    audiences: list(
      'GOOGLE_CLIENT_IDS',
      [
        getEnv('GOOGLE_CLIENT_ID', ''),
        '177354445918-qlv0e9um253f035ij2b9p5bavvd4h9pf.apps.googleusercontent.com',
      ].join(','),
    ),
    // Off until the mobile apps' client IDs are known; see the log below.
    enforce: getEnvBoolean('GOOGLE_ENFORCE_AUDIENCE', false),
  },
  apple: {
    // The web's Services ID, and the iOS app's bundle ID.
    audiences: list(
      'APPLE_CLIENT_IDS',
      'sk.freemap.service,sk.bigware.freemap',
    ),
    enforce: getEnvBoolean('APPLE_ENFORCE_AUDIENCE', true),
  },
};

function list(variable: string, dflt: string): Set<string> {
  return new Set(
    getEnv(variable, dflt)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * Refuses (or, not enforced, only logs) a token issued to another app, and
 * says whether it is ours. The log names the app, to collect the IDs before
 * enforcing. `undefined`: the provider couldn't say which app.
 */
export function checkTokenAudience(
  ctx: ParameterizedContext,
  provider: Provider,
  audiences: string[] | undefined,
): boolean {
  const { audiences: allowed, enforce } = config[provider];

  if (audiences?.some((aud) => allowed.has(aud))) {
    return true;
  }

  ctx.log.warn(
    { provider, audiences, enforce, userAgent: ctx.get('user-agent') },
    audiences
      ? 'Login token issued to another app'
      : 'Login token of an unknown app',
  );

  if (enforce) {
    // Unknown is the provider failing, worth a retry; not a foreign token.
    return audiences
      ? ctx.throw(401, 'token for another app')
      : ctx.throw(502, 'provider unavailable');
  }

  return false;
}
