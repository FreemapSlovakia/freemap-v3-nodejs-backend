import { RouterInstance } from '@koa/router';
import { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { runInTransaction } from '../../database.js';
import { storeTrackPoint } from '../../deviceTracking.js';
import { registerPath } from '../../openapi.js';

const TrackResponseSchema = z.strictObject({ id: z.uint32() });

export function attachTrackDeviceUrlEncodedHandler(router: RouterInstance) {
  registerPath('/tracking/track/{token}', {
    get: {
      summary: 'Submit a device location update via URL parameters',
      tags: ['tracking'],
      requestParams: {
        path: z.object({
          token: z.string().nonempty(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: TrackResponseSchema } },
        },
        400: {},
        404: { description: 'no such tracking device' },
      },
    },
    post: {
      summary: 'Submit a device location update via form-encoded body',
      tags: ['tracking'],
      requestParams: {
        path: z.object({
          token: z.string().nonempty(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: TrackResponseSchema } },
        },
        400: {},
        404: { description: 'no such tracking device' },
      },
    },
  });

  for (const method of ['post', 'get'] as const) {
    router[method]('/track/:token', urlEncodedHandler);
  }
}

async function urlEncodedHandler(ctx: ParameterizedContext) {
  await runInTransaction(async (conn) => {
    const [item] = await conn.query(
      sql`SELECT id, maxCount, maxAge FROM trackingDevice WHERE token = ${ctx.params.token}`,
    );

    if (!item) {
      ctx.throw(404, 'no such tracking device');
    }

    const q: Record<string, string> = {};

    for (const [k, v] of Object.entries(ctx.query)) {
      if (v !== undefined) {
        q[k] = Array.isArray(v) ? v[0] : v;
      }
    }

    if (
      ctx.request.body &&
      typeof ctx.request.body === 'object' &&
      Object.values(ctx.request.body).every((v) => typeof v === 'string')
    ) {
      Object.assign(q, ctx.request.body);
    }

    let lat;

    let lon;

    if (q.location) {
      const loc = q.location.split(',');

      lat = Number.parseFloat(loc[0]);

      lon = Number.parseFloat(loc[1]);
    } else if (q.lat && q.lon) {
      lat = Number.parseFloat(q.lat);

      lon = Number.parseFloat(q.lon);
    } else {
      ctx.throw(400, 'missing location');
    }

    function tryFloat(value: string | undefined) {
      return value !== undefined ? Number.parseFloat(value) : undefined;
    }

    const altitude = tryFloat(q.altitude || q.alt);

    const speedMs = tryFloat(q.speed);

    const speedKmh = tryFloat(q.speedKmh);

    const accuracy = tryFloat(q.acc || q.accuracy);

    const hdop = tryFloat(q.hdop);

    const bearing = tryFloat(q.bearing || q.heading);

    const battery = tryFloat(q.battery || q.batt);

    const gsmSignal = tryFloat(q.gsm_signal);

    const time = guessTime(q.time || q.timestamp);

    try {
      const id = await storeTrackPoint(
        conn,
        item.id,
        item.maxAge,
        item.maxCount,
        speedKmh,
        speedMs,
        lat,
        lon,
        altitude,
        accuracy,
        hdop,
        bearing,
        battery,
        gsmSignal,
        q.message ?? null,
        time,
      );

      ctx.body = { id };
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid param') {
        ctx.throw(400, 'one or more values provided are not valid');
      }

      throw err;
    }
  });
}

export function guessTime(t: string) {
  const now = new Date();

  if (!t) {
    return now;
  }

  const min = new Date();

  min.setDate(min.getDate() - 2);

  const max = new Date();

  max.setDate(max.getDate() + 1);

  const d1 = new Date(t);

  if (max > d1 && d1 > min) {
    return d1;
  }

  const n = Number.parseInt(t, 10);

  if (Number.isNaN(n)) {
    return undefined;
  }

  const d2 = new Date(n);

  if (max > d2 && d2 > min) {
    return d2;
  }

  const d3 = new Date((n < 1546300800 ? n + 619315200 : n) * 1000);

  if (max > d3 && d3 > min) {
    return d3;
  }

  return undefined;
}
