import sql, { empty, join } from 'sql-template-tag';
import * as ws from 'ws';
import { trackRegister } from '../trackRegister';
import { pool } from '../database';
import { RpcContext } from '../rpcHandlerTypes';

export function trackingSubscribeHandler(ctx: RpcContext) {
  // TODO validate ctx.params
  const { token, deviceId, fromTime, maxCount, maxAge } = ctx.params;

  (async () => {
    const { user } = ctx.ctx.state || {};

    if (deviceId) {
      const [row] = await pool.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${deviceId}`,
      );

      if (!row) {
        ctx.respondError(404, 'no such device');
        return;
      }

      if (!user || (!user.isAdmin && row.userId !== user.id)) {
        ctx.respondError(403, 'forbidden');
        return;
      }
    } else if (token) {
      const [row] = await pool.query(
        sql`SELECT 1 FROM trackingAccessToken WHERE token = ${token}`,
      );

      if (!row) {
        ctx.ctx.throw(404, 'no such token');
      }
    }

    // TODO check if token exists

    let websockets = trackRegister.get(deviceId || token);

    if (!websockets) {
      websockets = new Set<ws>();
      trackRegister.set(deviceId || token, websockets);
    }

    websockets.add(ctx.ctx.websocket);

    let result: any[];

    if (maxCount === 0 || maxAge === 0) {
      result = [];
    } else {
      const query = sql`
        SELECT trackingPoint.id, lat, lon, message, trackingPoint.createdAt, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal
        FROM trackingPoint
        ${
          deviceId
            ? sql` WHERE deviceId = ${deviceId}`
            : sql` JOIN trackingAccessToken
                     ON trackingPoint.deviceId = trackingAccessToken.deviceId
                     WHERE trackingAccessToken.token = ${token}`
        }
        ${
          fromTime
            ? sql` AND trackingPoint.createdAt >= ${new Date(fromTime)}`
            : empty
        }
        ${
          maxAge
            ? sql` AND TIMESTAMPDIFF(SECOND, trackingPoint.createdAt, now()) < ${Number(
                maxAge,
              )}`
            : empty
        }
        ${
          token
            ? sql` AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom) AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)`
            : empty
        }
        ORDER BY trackingPoint.id DESC
        ${maxCount ? sql` LIMIT ${Number(maxCount)}` : empty}
      `;

      result = await pool.query(query);

      result.reverse();
    }

    // TODO skip nulls

    ctx.respondResult(
      result.map((item: any) => ({
        id: item.id,
        ts: item.createdAt,
        lat: item.lat,
        lon: item.lon,
        message: ntu(item.message),
        altitude: ntu(item.altitude),
        speed: ntu(item.speed),
        accuracy: ntu(item.accuracy),
        hdop: ntu(item.hdop),
        bearing: ntu(item.bearing),
        battery: ntu(item.battery),
        gsmSignal: ntu(item.gsmSignal),
      })),
    );
  })().catch((err) => {
    ctx.respondError(500, err.message);
  });
}

function ntu<T>(x: T): T | undefined {
  return x === null ? undefined : x;
}
