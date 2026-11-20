import { setTimeout as sleep } from 'node:timers/promises';
import Router from '@koa/router';
import type { Logger } from 'pino';
import z from 'zod';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { resolveElevations } from '../geotools/elevation.js';
import {
  ForecastSchema,
  forecastOfMet,
  MetResponseSchema,
} from './forecast.js';

// MET's terms: identify the app and a contact, keep below 20 requests/s, and
// don't ask again before `Expires`; If-Modified-Since makes the repeat cheap.
const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

const USER_AGENT = 'Freemap https://www.freemap.sk/ freemap@freemap.sk';

/** 10 requests/s, queued rather than refused, up to a wait of… */
const UPSTREAM_INTERVAL_MS = 100;

const MAX_WAIT_MS = 5000;

const MIN_TTL_MS = 10 * 60_000;

const MAX_TTL_MS = 6 * 3_600_000;

/** How long a failing MET is left alone. */
const RETRY_MS = 60_000;

/** How long a point MET refused isn't asked for again. */
const REFUSED_MS = 10 * 60_000;

const ELEVATION_TIMEOUT_MS = 3000;

/** Older than this, a forecast is no answer even while MET fails. */
const STALE_MAX_MS = 12 * 3_600_000;

// A forecast's JSON is ~20 kB.
const MAX_ENTRIES = 2000;

type Entry = {
  /** The response, serialized once. */
  body: string;
  elevation: number | null;
  /** When MET last gave or confirmed it. */
  fetchedAt: number;
  expires: number;
  lastModified: string | null;
};

// Keyed by the 3-decimal (~100 m) position MET is asked for; least recently
// used first.
const cache = new Map<string, Entry>();

const inFlight = new Map<string, Promise<Entry>>();

let nextSlot = 0;

/** Until when MET is not asked, after it failed; per point would retry per point. */
let metDownUntil = 0;

/** Points MET refused, until when they aren't asked for again. */
const refused = new Map<string, number>();

function queueFull() {
  return nextSlot - Date.now() > MAX_WAIT_MS;
}

/** Waits for this request's turn upstream; false when the queue is too long. */
async function upstreamTurn(): Promise<boolean> {
  if (queueFull()) {
    return false;
  }

  const now = Date.now();

  const at = Math.max(now, nextSlot);

  nextSlot = at + UPSTREAM_INTERVAL_MS;

  if (at > now) {
    await sleep(at - now);
  }

  return true;
}

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function store(key: string, entry: Entry) {
  cache.delete(key);

  cache.set(key, entry);

  if (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }

  return entry;
}

async function terrainElevation(
  lat: number,
  lon: number,
  log: Pick<Logger, 'warn'>,
): Promise<number | null> {
  try {
    // The best model for every caller: one rounded height per forecast gives
    // away nothing premium sells. Bounded, as an SRTM tile may be downloading.
    const resolved = await Promise.race([
      resolveElevations([[lat, lon]], true, log).then((e) => e[0]),
      sleep(ELEVATION_TIMEOUT_MS).then(() => null),
    ]);

    return resolved == null ? null : Math.round(resolved);
  } catch (err) {
    // Only adjusts the temperature; MET answers without it.
    log.warn({ err }, 'no elevation for the forecast');

    return null;
  }
}

async function refresh(
  key: string,
  lat: number,
  lon: number,
  stale: Entry | undefined,
  log: Pick<Logger, 'warn'>,
): Promise<Entry> {
  // A recent stale answer beats none whenever MET or our own budget fails us;
  // it is kept a little longer, so a failing MET isn't asked again at once.
  const failed = (status: number, err: unknown) => {
    if (stale && Date.now() - stale.fetchedAt < STALE_MAX_MS) {
      log.warn({ err }, 'MET forecast failed; serving the stale one');

      return store(key, { ...stale, expires: Date.now() + RETRY_MS });
    }

    throw new UpstreamError(status, `MET forecast failed: ${err}`);
  };

  const metDown = (err: unknown) => {
    metDownUntil = Date.now() + RETRY_MS;

    return failed(502, err);
  };

  if (Date.now() < metDownUntil) {
    return failed(502, 'MET failed a moment ago');
  }

  if ((refused.get(key) ?? 0) > Date.now()) {
    return failed(502, 'MET refused this point a moment ago');
  }

  if (queueFull()) {
    return failed(503, 'too many forecast requests');
  }

  // Before the turn upstream, so a slow lookup doesn't spend it. A missing
  // height is looked for again: the lookup may have failed only for a while.
  const elevation =
    stale && stale.elevation !== null
      ? stale.elevation
      : await terrainElevation(lat, lon, log);

  if (!(await upstreamTurn())) {
    return failed(503, 'too many forecast requests');
  }

  const url = new URL(MET_URL);

  url.searchParams.set('lat', String(lat));

  url.searchParams.set('lon', String(lon));

  if (elevation !== null) {
    url.searchParams.set('altitude', String(elevation));
  }

  const headers: Record<string, string> = { 'user-agent': USER_AGENT };

  // Not once a height was found since: the stored body was asked for without it.
  if (stale?.lastModified && stale.elevation === elevation) {
    headers['if-modified-since'] = stale.lastModified;
  }

  let res: Response;

  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return metDown(err);
  }

  const expiresAt = Date.parse(res.headers.get('expires') ?? '');

  const expires = Math.min(
    Date.now() + MAX_TTL_MS,
    Math.max(Date.now() + MIN_TTL_MS, Number.isNaN(expiresAt) ? 0 : expiresAt),
  );

  if (res.status === 304 && stale) {
    return store(key, { ...stale, expires, fetchedAt: Date.now() });
  }

  // 203 is MET's "deprecated product" warning, still with a body.
  if (res.status !== 200 && res.status !== 203) {
    // Unread, the body would hold its connection.
    await res.body?.cancel();

    // 403 is MET refusing us, not the point.
    if (res.status >= 500 || res.status === 429 || res.status === 403) {
      return metDown(res.status);
    }

    refused.delete(key);

    refused.set(key, Date.now() + REFUSED_MS);

    if (refused.size > MAX_ENTRIES) {
      refused.delete(refused.keys().next().value!);
    }

    return failed(502, res.status);
  }

  let body: string;

  try {
    body = JSON.stringify(
      forecastOfMet(MetResponseSchema.parse(await res.json()), elevation),
    );
  } catch (err) {
    return failed(502, err);
  }

  return store(key, {
    body,
    elevation,
    fetchedAt: Date.now(),
    expires,
    lastModified: res.headers.get('last-modified'),
  });
}

function getForecast(lat: number, lon: number, log: Pick<Logger, 'warn'>) {
  const rLat = Math.round(lat * 1000) / 1000;

  const rLon = Math.round(lon * 1000) / 1000;

  const key = `${rLat},${rLon}`;

  const hit = cache.get(key);

  if (hit && hit.expires > Date.now()) {
    return store(key, hit);
  }

  let promise = inFlight.get(key);

  if (!promise) {
    promise = refresh(key, rLat, rLon, hit, log).finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, promise);
  }

  return promise;
}

// Not a bare coerce: an empty or blank value would read as 0.
const coordinate = (limit: number) =>
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().min(-limit).max(limit));

const QuerySchema = z.object({
  lat: coordinate(90),
  lon: coordinate(180),
});

registerPath('/weather/forecast', {
  get: {
    summary: 'Weather forecast for a point',
    description:
      'Hourly for about 2.5 days, then 6-hourly up to about 9 days. The point is rounded to 3 decimals and the temperature adjusted to its terrain elevation. Cached until the provider has a newer forecast.',
    tags: ['weather'],
    requestParams: { query: QuerySchema },
    responses: {
      200: { content: { 'application/json': { schema: ForecastSchema } } },
      400: {},
      502: { description: 'the provider failed' },
      503: { description: 'too many forecasts asked for at once' },
    },
  },
});

const router = new Router();

router.get('/forecast', acceptValidator('application/json'), async (ctx) => {
  const query = QuerySchema.safeParse(ctx.query);

  if (!query.success) {
    return ctx.throw(400, query.error);
  }

  let entry: Entry;

  try {
    entry = await getForecast(query.data.lat, query.data.lon, ctx.log);
  } catch (err) {
    // Answered, not thrown: an upstream outage is no error of ours to report.
    if (err instanceof UpstreamError) {
      ctx.status = err.status;

      ctx.set('Cache-Control', 'no-store');

      ctx.body = err.message;

      return;
    }

    throw err;
  }

  ctx.set(
    'Cache-Control',
    `public, max-age=${Math.max(60, Math.floor((entry.expires - Date.now()) / 1000))}`,
  );

  ctx.type = 'application/json';

  ctx.body = entry.body;
});

export const weatherRouter = router;
