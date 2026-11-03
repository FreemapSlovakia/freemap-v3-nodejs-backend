import { createPolar, type Polar, webhooks } from '@polar-sh/sdk/2026-10';
import { getEnv } from './env.js';

// The import path pins the Polar API version (sent as `Polar-Version`). Polar
// ships a new version in the first week of January, April, July and October;
// bump it only together with a review of the changed endpoints and webhook
// payloads. Webhooks are re-exported so they parse with the same version.

export { webhooks };

let polar: Polar | undefined;

/** Lazily-constructed Polar SDK client. */
export function getPolar(): Polar {
  if (!polar) {
    polar = createPolar({
      accessToken: getEnv('POLAR_ACCESS_TOKEN'),
      environment: getEnv('POLAR_SERVER', 'sandbox') as
        | 'sandbox'
        | 'production',
      // The SDK default is 5 s, short enough to fail a slow checkout creation.
      timeout: 30,
    });
  }

  return polar;
}
