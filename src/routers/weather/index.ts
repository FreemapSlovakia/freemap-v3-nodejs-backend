import { setTimeout as sleep } from 'node:timers/promises';
import Router from '@koa/router';
import type { Logger } from 'pino';
import z from 'zod';
import { getEnv } from '../../env.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { resolveElevations } from '../geotools/elevation.js';
import { inCoverage } from './coverage.js';
import {
  ForecastSchema,
  forecastOfOpenMeteo,
  OPEN_METEO_DAILY,
  OPEN_METEO_HOURLY,
  OpenMeteoResponseSchema,
} from './forecast.js';

// Our own Open-Meteo instance on fm5, which answers fm6 only.
const OPEN_METEO_URL = getEnv(
  'OPEN_METEO_URL',
  'https://weather.freemap.sk/v1/forecast',
);

const FORECAST_DAYS = 16;

/** 50 requests/s, queued rather than refused, up to a wait of… */
const UPSTREAM_INTERVAL_MS = 20;

const MAX_WAIT_MS = 5000;

// The models are run every 1 to 6 hours.
const TTL_MS = 30 * 60_000;

/** How long a failing Open-Meteo is left alone. */
const RETRY_MS = 60_000;

const ELEVATION_TIMEOUT_MS = 3000;

/** Older than this, a forecast is no answer even while Open-Meteo fails. */
const STALE_MAX_MS = 12 * 3_600_000;

// A forecast's JSON is ~200 kB; a miss costs our own Open-Meteo milliseconds.
const MAX_ENTRIES = 500;

type Entry = {
  /** The response, serialized once. */
  body: string;
  elevation: number | null;
  /** When Open-Meteo last gave it. */
  fetchedAt: number;
  expires: number;
};

// Keyed by the 3-decimal (~100 m) position Open-Meteo is asked for; least
// recently used first.
const cache = new Map<string, Entry>();

const inFlight = new Map<string, Promise<Entry>>();

let nextSlot = 0;

/** Until when Open-Meteo is not asked, after it failed; per point would retry per point. */
let upstreamDownUntil = 0;

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
    // Only adjusts the temperature; Open-Meteo answers without it.
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
  // A recent stale answer beats none whenever Open-Meteo or our own budget
  // fails us; it is kept a little longer, so a failing Open-Meteo isn't asked
  // again at once.
  const failed = (status: number, err: unknown) => {
    if (stale && Date.now() - stale.fetchedAt < STALE_MAX_MS) {
      log.warn({ err }, 'Open-Meteo forecast failed; serving the stale one');

      return store(key, { ...stale, expires: Date.now() + RETRY_MS });
    }

    throw new UpstreamError(status, `Open-Meteo forecast failed: ${err}`);
  };

  const upstreamDown = (err: unknown) => {
    upstreamDownUntil = Date.now() + RETRY_MS;

    return failed(502, err);
  };

  if (Date.now() < upstreamDownUntil) {
    return failed(502, 'Open-Meteo failed a moment ago');
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

  const url = new URL(OPEN_METEO_URL);

  url.searchParams.set('latitude', String(lat));

  url.searchParams.set('longitude', String(lon));

  if (elevation !== null) {
    url.searchParams.set('elevation', String(elevation));
  }

  url.searchParams.set('hourly', OPEN_METEO_HOURLY.join(','));

  url.searchParams.set('daily', OPEN_METEO_DAILY.join(','));

  url.searchParams.set('forecast_days', String(FORECAST_DAYS));

  url.searchParams.set('timeformat', 'unixtime');

  url.searchParams.set('wind_speed_unit', 'ms');

  // Sunrise and sunset by the place's own days, as clients group days; the
  // times themselves stay unix.
  url.searchParams.set('timezone', 'auto');

  let res: Response;

  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return upstreamDown(err);
  }

  if (res.status !== 200) {
    // Unread, the body would hold its connection.
    await res.body?.cancel();

    // A refused request fails alone; an instance failing, for every point.
    return res.status >= 400 && res.status < 500 && res.status !== 429
      ? failed(502, res.status)
      : upstreamDown(res.status);
  }

  let body: string;

  try {
    body = JSON.stringify(
      forecastOfOpenMeteo(
        OpenMeteoResponseSchema.parse(await res.json()),
        elevation,
        Date.now(),
      ),
    );
  } catch (err) {
    return failed(502, err);
  }

  return store(key, {
    body,
    elevation,
    fetchedAt: Date.now(),
    expires: Date.now() + TTL_MS,
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
    summary: 'Weather forecast for a point in Europe',
    description:
      'Hourly for 16 days. The point is rounded to 3 decimals and the temperature adjusted to its terrain elevation. Cached for 30 minutes.',
    tags: ['weather'],
    requestParams: { query: QuerySchema },
    responses: {
      200: { content: { 'application/json': { schema: ForecastSchema } } },
      400: {},
      404: { description: 'the point is outside Europe' },
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

  if (!inCoverage(query.data.lat, query.data.lon)) {
    ctx.status = 404;

    // Short: the region may grow.
    ctx.set('Cache-Control', 'public, max-age=3600');

    // The web app tells this 404 from others by "outside Europe".
    ctx.body = 'no forecast outside Europe';

    return;
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
