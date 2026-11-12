import sql, { empty } from 'sql-template-tag';
import z from 'zod';
import { pool } from './database.js';
import type { User } from './koaTypes.js';
import { isOwnerOrRole } from './roles.js';

export const SubscribeParamsSchema = z.intersection(
  z.object({
    fromTime: z.iso.datetime().nullish(),
    maxCount: z.uint32().nullish(),
    maxAge: z.uint32().nullish(),
  }),
  z.union([
    z.object({ token: z.string().nonempty() }),
    z.object({ deviceId: z.uint32() }),
  ]),
);

export type SubscribeParams = z.infer<typeof SubscribeParamsSchema>;

export function subscriptionKey(params: SubscribeParams) {
  return 'deviceId' in params ? params.deviceId : params.token;
}

/** Returns the HTTP status refusing the subscription, or `null` to allow it. */
export async function checkTrackingAccess(
  user: User | undefined,
  params: SubscribeParams,
): Promise<404 | 403 | null> {
  if ('deviceId' in params) {
    const [row] = await pool.query<{ userId: number }[]>(
      sql`SELECT userId FROM trackingDevice WHERE id = ${params.deviceId}`,
    );

    if (!row) {
      return 404;
    }

    return isOwnerOrRole(user, row.userId, 'trackingManager') ? null : 403;
  }

  const [row] = await pool.query<unknown[]>(
    sql`SELECT 1 FROM trackingAccessToken WHERE token = ${params.token}`,
  );

  return row ? null : 404;
}

const TrackPointRowSchema = z.strictObject({
  id: z.number(),
  createdAt: z.date(),
  lat: z.number(),
  lon: z.number(),
  message: z.string().nullable(),
  altitude: z.number().nullable(),
  speed: z.number().nullable(),
  accuracy: z.number().nullable(),
  hdop: z.number().nullable(),
  bearing: z.number().nullable(),
  battery: z.number().nullable(),
  gsmSignal: z.number().nullable(),
});

/**
 * Points in chronological order. With `afterId`, only the points after it, and
 * the subscription's `fromTime`/`maxAge`/`maxCount` are not applied.
 */
export async function queryTrackPoints(
  params: SubscribeParams,
  afterId?: number,
) {
  const { fromTime, maxCount, maxAge } =
    afterId === undefined
      ? params
      : { fromTime: undefined, maxCount: undefined, maxAge: undefined };

  if (maxCount === 0 || maxAge === 0) {
    return [];
  }

  const rows = await pool.query<unknown[]>(sql`
    SELECT trackingPoint.id, lat, lon, message, trackingPoint.createdAt, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal
    FROM trackingPoint
    ${
      'deviceId' in params
        ? sql` WHERE deviceId = ${params.deviceId}`
        : sql` JOIN trackingAccessToken
                 ON trackingPoint.deviceId = trackingAccessToken.deviceId
                 WHERE trackingAccessToken.token = ${params.token}`
    }
    ${afterId === undefined ? empty : sql` AND trackingPoint.id > ${afterId}`}
    ${fromTime ? sql` AND trackingPoint.createdAt >= ${new Date(fromTime)}` : empty}
    ${
      maxAge
        ? sql` AND trackingPoint.createdAt > NOW() - INTERVAL ${maxAge} SECOND`
        : empty
    }
    ${
      'token' in params
        ? sql` AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom) AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)`
        : empty
    }
    ORDER BY trackingPoint.createdAt DESC, trackingPoint.id DESC
    ${maxCount ? sql` LIMIT ${maxCount}` : empty}
  `);

  return TrackPointRowSchema.array()
    .parse(rows)
    .reverse()
    .map((item) => ({
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
    }));
}

export type TrackPoint = Awaited<ReturnType<typeof queryTrackPoints>>[number];

function ntu<T>(x: T): T | undefined {
  return x === null ? undefined : x;
}
