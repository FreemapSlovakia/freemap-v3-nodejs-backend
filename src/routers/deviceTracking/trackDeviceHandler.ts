import Router from '@koa/router';
import { ParameterizedContext } from 'koa';
import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { storeTrackPoint } from '../../deviceTracking';

export function attachTrackDeviceHandler(router: Router) {
  for (const method of ['post', 'get'] as const) {
    router[method]('/track/:token', runInTransaction(), handler);
  }
}

async function handler(ctx: ParameterizedContext) {
  const conn = ctx.state.dbConn;

  const [item] = await conn.query(
    SQL`SELECT id, maxCount, maxAge FROM trackingDevice WHERE token = ${ctx.params.token}`,
  );

  if (!item) {
    ctx.throw(404, 'no such tracking device');
  }

  const q =
    ctx.query?.lat && ctx.query?.lon ? ctx.query : ctx.request.body || {};

  const { message } = q;

  const lat = Number.parseFloat(q.lat);

  const lon = Number.parseFloat(q.lon);

  const altitude =
    (q.alt || q.altitude) === undefined
      ? null
      : Number.parseFloat(q.alt || q.altitude);

  const speedMs = q.speed === undefined ? null : Number.parseFloat(q.speed);

  const speedKmh =
    q.speedKmh === undefined ? null : Number.parseFloat(q.speedKmh);

  const accuracy = q.acc === undefined ? null : Number.parseFloat(q.acc);

  const hdop = q.hdop === undefined ? null : Number.parseFloat(q.hdop);

  const bearing = q.bearing === undefined ? null : Number.parseFloat(q.bearing);

  const battery =
    (q.battery || q.batt) === undefined
      ? null
      : Number.parseFloat(q.battery || q.batt);

  const gsmSignal =
    q.gsm_signal === undefined ? null : Number.parseFloat(q.gsm_signal);

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
      message ?? null,
      time,
    );

    ctx.body = { id };
  } catch (err) {
    if (err.message === 'invalid param') {
      ctx.throw(400, 'one or more values provided are not valid');
    }

    throw err;
  }
}

function guessTime(t: string) {
  const now = new Date();

  const min = new Date();

  min.setDate(min.getDate() - 2);

  const max = new Date();

  max.setDate(max.getDate() + 1);

  if (!t) {
    return now;
  }

  const d1 = new Date(t);

  if (max > d1 && d1 > min) {
    return d1;
  }

  const n = Number.parseInt(t, 10);

  if (Number.isNaN(n)) {
    return null;
  }

  const d2 = new Date(n);

  if (max > d2 && d2 > min) {
    return d2;
  }

  const d3 = new Date(n * 1000);

  if (max > d3 && d3 > min) {
    return d3;
  }

  return null;
}
