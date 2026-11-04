import z from 'zod';
import { appLogger } from './logger.js';
import { OSM_API_BASE, OSM_USER_AGENT } from './osm.js';

const logger = appLogger.child({ module: 'providerProfiles' });

export type ProviderProfile = { url: string; name: string };

const TIMEOUT_MS = 3000;

const HIT_TTL_MS = 24 * 3600_000;

// GitHub's unauthenticated limit resets hourly.
const MISS_TTL_MS = 3600_000;

const MAX_ENTRIES = 10_000;

// Promises, so concurrent opens of one profile share a single lookup.
const cache = new Map<
  string,
  { value: Promise<ProviderProfile | null>; expiresAt: number }
>();

const OsmUserSchema = z.object({
  user: z.object({ display_name: z.string() }),
});

const GithubUserSchema = z.object({ login: z.string(), html_url: z.url() });

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    await res.body?.cancel();

    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

async function fetchProfile(
  provider: 'osm' | 'github',
  id: string,
): Promise<ProviderProfile> {
  if (provider === 'osm') {
    const name = OsmUserSchema.parse(
      await fetchJson(`${OSM_API_BASE}/user/${id}.json`, {
        'user-agent': OSM_USER_AGENT,
      }),
    ).user.display_name;

    return {
      url: `https://www.openstreetmap.org/user/${encodeURIComponent(name)}`,
      name,
    };
  }

  // Unauthenticated: 60 requests an hour per IP, hence the cache.
  const user = GithubUserSchema.parse(
    await fetchJson(`https://api.github.com/user/${id}`, {
      'user-agent': OSM_USER_AGENT,
    }),
  );

  return { url: user.html_url, name: user.login };
}

/**
 * OSM and GitHub address a profile by name, not by the id a login stores, so it
 * is looked up — server side, keeping visitors' IPs from the providers.
 * `null` when the provider can't say.
 */
export function providerProfile(
  provider: 'osm' | 'github',
  id: string,
): Promise<ProviderProfile | null> {
  const key = `${provider}/${id}`;

  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // Re-set below, so the map's order is the order of lookups: the first
  // entry is the oldest.
  cache.delete(key);

  if (cache.size >= MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }

  const entry = {
    // Until it settles, a pending lookup is shared, never repeated.
    expiresAt: Number.POSITIVE_INFINITY,
    value: fetchProfile(provider, id).then(
      (profile) => {
        entry.expiresAt = Date.now() + HIT_TTL_MS;

        return profile;
      },
      (err: unknown) => {
        logger.warn({ err, provider, id }, 'profile lookup failed');

        entry.expiresAt = Date.now() + MISS_TTL_MS;

        return null;
      },
    ),
  };

  cache.set(key, entry);

  return entry.value;
}
