import Router from '@koa/router';
import { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import { assert, tags } from 'typia';
import { runInTransaction } from '../../database.js';
import { storeTrackPoint } from '../../deviceTracking.js';

export function attachTrackDeviceHandler(router: Router) {
  for (const method of ['post', 'get'] as const) {
    router[method]('/track/:token', runInTransaction(), urlEncodedHandler);
  }

  router.post('/track', runInTransaction(), jsonHandler);
}

async function jsonHandler(ctx: ParameterizedContext) {
  type Body =
    | {
        id: string;
        notificationToken: string;
      }
    | {
        device_id: string;
        location: {
          timestamp: string & tags.Format<'date-time'>;
          coords: {
            latitude: number & tags.Minimum<-90> & tags.Maximum<90>;
            longitude: number & tags.Minimum<-180> & tags.Maximum<180>;
            accuracy?: number & tags.Minimum<0>;
            speed?: number; // seen -1
            heading?: number; // seen -1
            altitude?: number;
          };
          is_moving?: boolean;
          odometer?: number & tags.Minimum<0>;
          event?: string;
          battery?: {
            level?: number & tags.Minimum<0> & tags.Maximum<1>;
            is_charging?: boolean;
          };
          activity?: {
            type?: string;
          };
          extras?: Record<string, unknown>;
        };
      };

  let body;

  try {
    body = assert<Body>(ctx.request.body);
  } catch (err) {
    console.log(ctx.request.body);

    ctx.throw(400, err as Error);
  }

  if ('notificationToken' in body) {
    ctx.throw(400, 'notifications are not supported');
  }

  const conn = ctx.state.dbConn!;

  const [item] = await conn.query(
    sql`SELECT id, maxCount, maxAge FROM trackingDevice WHERE token = ${body.device_id}`,
  );

  if (!item) {
    ctx.throw(404, 'no such tracking device');
  }

  const {
    battery,
    timestamp,
    coords: { speed, latitude, longitude, altitude, accuracy, heading },
    event,
    activity,
  } = body.location;

  try {
    const id = await storeTrackPoint(
      conn,
      item.id,
      item.maxAge,
      item.maxCount,
      undefined,
      speed === -1 ? undefined : speed,
      latitude,
      longitude,
      altitude,
      accuracy,
      undefined,
      heading === -1 ? undefined : heading,
      battery?.level === undefined ? undefined : battery?.level * 100,
      undefined,
      [event, activity?.type].filter((a) => a).join(', ') || undefined,
      new Date(timestamp),
    );

    ctx.body = { id };
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid param') {
      ctx.throw(400, 'one or more values provided are not valid');
    }

    throw err;
  }
}

async function urlEncodedHandler(ctx: ParameterizedContext) {
  const conn = ctx.state.dbConn!;

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
}

function guessTime(t: string) {
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
