import { Polar } from '@polar-sh/sdk';
import { getEnv } from './env.js';

let polar: Polar | undefined;

/** Lazily-constructed Polar SDK client. */
export function getPolar(): Polar {
  if (!polar) {
    polar = new Polar({
      accessToken: getEnv('POLAR_ACCESS_TOKEN'),
      server: getEnv('POLAR_SERVER', 'sandbox') as 'sandbox' | 'production',
    });
  }

  return polar;
}
