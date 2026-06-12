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

/**
 * Whether Polar payments are enabled for the given user. While we run Polar and
 * the legacy Rovas flow in parallel, the new flow is limited to an explicit
 * allowlist (comma-separated user IDs in `POLAR_ENABLED_USER_IDS`).
 */
export function isPolarEnabled(userId: number): boolean {
  return getEnv('POLAR_ENABLED_USER_IDS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(userId));
}
