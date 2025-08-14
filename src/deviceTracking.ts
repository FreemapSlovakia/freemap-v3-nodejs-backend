import { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import { trackRegister } from './trackRegister.js';

export async function storeTrackPoint(
  conn: PoolConnection,
  id: number,
  maxAge: number | undefined,
  maxCount: number | undefined,
  speedKmh: number | undefined,
  speedMs: number | undefined,
  lat: number,
  lon: number,
  altitude: number | undefined,
  accuracy: number | undefined,
  hdop: number | undefined,
  bearing: number | undefined,
  battery: number | undefined,
  gsmSignal: number | undefined,
  message: string | undefined,
  time: Date | undefined,
) {
  if (
    time === undefined ||
    Number.isNaN(lat) ||
    lat < -90 ||
    lat > 90 ||
    Number.isNaN(lon) ||
    lon < -180 ||
    lon > 180 ||
    Number.isNaN(battery) ||
    (battery !== undefined && (battery < 0 || battery > 100)) ||
    Number.isNaN(gsmSignal) ||
    (gsmSignal !== undefined && (gsmSignal < 0 || gsmSignal > 100)) ||
    Number.isNaN(bearing) ||
    (bearing !== undefined && (bearing < 0 || bearing > 360)) ||
    Number.isNaN(accuracy) ||
    (accuracy !== undefined && accuracy < 0) ||
    Number.isNaN(hdop) ||
    (hdop !== undefined && hdop < 0) ||
    Number.isNaN(speedMs) ||
    (speedMs !== undefined && speedMs < 0) ||
    Number.isNaN(speedKmh) ||
    (speedKmh !== undefined && speedKmh < 0)
  ) {
    throw new Error('invalid param');
  }

  const now = new Date();

  // const { id, maxAge, maxCount } = item;

  const speed = typeof speedKmh === 'number' ? speedKmh / 3.6 : speedMs;

  const { insertId } = await conn.query(sql`
    INSERT INTO trackingPoint SET
      deviceId = ${id},
      lat = ${lat},
      lon = ${lon},
      altitude = ${altitude},
      speed = ${speed},
      accuracy = ${accuracy},
      hdop = ${hdop},
      bearing = ${bearing},
      battery = ${battery},
      gsmSignal = ${gsmSignal},
      message = ${message},
      createdAt = ${time}
  `);

  if (maxAge != null) {
    await conn.query(
      sql`DELETE FROM trackingPoint WHERE deviceId = ${id} AND TIMESTAMPDIFF(SECOND, createdAt, NOW()) > ${maxAge}`,
    );
  }

  if (maxCount != null) {
    await conn.query(sql`
      DELETE t FROM trackingPoint AS t JOIN (
        SELECT id FROM trackingPoint WHERE deviceId = ${id}
          ORDER BY id DESC LIMIT 18446744073709551615 OFFSET ${maxCount}
      ) tlimit ON t.id = tlimit.id
    `);
  }

  const rows = await conn.query(sql`
    SELECT token FROM trackingAccessToken
      WHERE deviceId = ${id} AND (timeFrom IS NULL OR timeFrom < ${now}) AND (timeTo IS NULL OR timeTo > ${now})
  `);

  const notify = (type: string, key: string | number) => {
    const websockets = trackRegister.get(key);

    if (websockets) {
      for (const ws of websockets) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'tracking.addPoint',
              params: {
                // TODO validate if time matches limits
                id: insertId,
                lat,
                lon,
                altitude,
                speed,
                accuracy,
                hdop,
                bearing,
                battery,
                gsmSignal,
                message,
                [type]: key,
                ts: time.toISOString(),
              },
            }),
          );
        }
      }
    }
  };

  for (const { token } of rows) {
    notify('token', token);
  }

  notify('deviceId', id);

  return insertId;
}
