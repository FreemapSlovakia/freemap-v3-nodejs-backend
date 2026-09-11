import { Polar } from '@polar-sh/sdk';
import { HTTPClient } from '@polar-sh/sdk/lib/http.js';
import { getEnv } from './env.js';

/**
 * API contract the integration is pinned to. Polar ships a new version in the
 * first week of January, April, July and October; unpinned requests follow
 * whatever is current at the time, so we send the header explicitly. Bump this
 * only together with a review of the changed endpoints and webhook payloads.
 */
const POLAR_API_VERSION = '2026-04';

let polar: Polar | undefined;

/** Lazily-constructed Polar SDK client, pinned to {@link POLAR_API_VERSION}. */
export function getPolar(): Polar {
  if (!polar) {
    const httpClient = new HTTPClient();

    httpClient.addHook('beforeRequest', (req) => {
      req.headers.set('Polar-Version', POLAR_API_VERSION);
    });

    polar = new Polar({
      accessToken: getEnv('POLAR_ACCESS_TOKEN'),
      server: getEnv('POLAR_SERVER', 'sandbox') as 'sandbox' | 'production',
      httpClient,
    });
  }

  return polar;
}
