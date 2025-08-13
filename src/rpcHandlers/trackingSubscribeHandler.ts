import sql, { empty } from 'sql-template-tag';
import WebSocket from 'ws';
import { pool } from '../database.js';
import { RpcContext } from '../rpcHandlerTypes.js';
import { trackRegister } from '../trackRegister.js';
import { assertGuard, tags } from 'typia';

export type SubscribeParams = {
  fromTime?: null | (string & tags.Format<'date-time'>);
  maxCount?: null | (number & tags.Type<'uint32'>);
  maxAge?: null | (number & tags.Type<'uint32'>);
} & (
  | {
      token: string;
    }
  | {
      deviceId: number & tags.Type<'uint32'>;
    }
);

export function trackingSubscribeHandler(
  ctx: RpcContext,
  params: SubscribeParams,
) {
  (async () => {
    const { user } = ctx.ctx.state || {};

    if ('deviceId' in params) {
      const [row] = await pool.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${params.deviceId}`,
      );

      if (!row) {
        ctx.respondError(404, 'no such device');
        return;
      }

      if (!user || (!user.isAdmin && row.userId !== user.id)) {
        ctx.respondError(403, 'forbidden');
        return;
      }
    } else {
      const [row] = await pool.query(
        sql`SELECT 1 FROM trackingAccessToken WHERE token = ${params.token}`,
      );

      if (!row) {
        ctx.ctx.throw(404, 'no such token');
      }
    }

    const key = 'deviceId' in params ? params.deviceId : params.token;

    let websockets = trackRegister.get(key);

    if (!websockets) {
      websockets = new Set<WebSocket>();
      trackRegister.set(key, websockets);
    }

    websockets.add(ctx.ctx.websocket);

    const { fromTime, maxCount, maxAge } = params;

    let result;

    if (maxCount === 0 || maxAge === 0) {
      result = [];
    } else {
      const query = sql`
        SELECT trackingPoint.id, lat, lon, message, trackingPoint.createdAt, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal
        FROM trackingPoint
        ${
          'deviceId' in params
            ? sql` WHERE deviceId = ${params.deviceId}`
            : sql` JOIN trackingAccessToken
                     ON trackingPoint.deviceId = trackingAccessToken.deviceId
                     WHERE trackingAccessToken.token = ${params.token}`
        }
        ${
          fromTime
            ? sql` AND trackingPoint.createdAt >= ${new Date(fromTime)}`
            : empty
        }
        ${
          maxAge
            ? sql` AND TIMESTAMPDIFF(SECOND, trackingPoint.createdAt, NOW()) < ${Number(
                maxAge,
              )}`
            : empty
        }
        ${
          'token' in params
            ? sql` AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom) AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)`
            : empty
        }
        ORDER BY trackingPoint.createdAt DESC, trackingPoint.id DESC
        ${maxCount ? sql` LIMIT ${Number(maxCount)}` : empty}
      `;

      result = await pool.query(query);

      result.reverse();
    }

    assertGuard<
      {
        id: number;
        createdAt: Date;
        lat: number;
        lon: number;
        message: string | null;
        altitude: number | null;
        speed: number | null;
        accuracy: number | null;
        hdop: number | null;
        bearing: number | null;
        battery: number | null;
        gsmSignal: number | null;
      }[]
    >(result);

    ctx.respondResult(
      result.map((item) => ({
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
