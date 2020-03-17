import { SQL } from 'sql-template-strings';
import { trackRegister } from './trackRegister';
import { PoolConnection } from 'mariadb';

export async function storeTrackPoint(
  conn: PoolConnection,
  id: number,
  maxAge: number | null,
  maxCount: number | null,
  speedKmh: number | null,
  speedMs: number | null,
  lat: number,
  lon: number,
  altitude: number | null,
  accuracy: number | null,
  hdop: number | null,
  bearing: number | null,
  battery: number | null,
  gsmSignal: number | null,
  message: string,
  time: Date,
) {
  if (
    time === null ||
    Number.isNaN(lat) ||
    lat < -90 ||
    lat > 90 ||
    Number.isNaN(lon) ||
    lon < -180 ||
    lon > 180 ||
    Number.isNaN(battery) ||
    (battery !== null && (battery < 0 || battery > 100)) ||
    Number.isNaN(gsmSignal) ||
    (gsmSignal !== null && (gsmSignal < 0 || gsmSignal > 100)) ||
    Number.isNaN(bearing) ||
    (bearing !== null && (bearing < 0 || bearing > 360)) ||
    Number.isNaN(accuracy) ||
    (accuracy !== null && accuracy < 0) ||
    Number.isNaN(hdop) ||
    (hdop !== null && hdop < 0) ||
    Number.isNaN(speedMs) ||
    (speedMs !== null && speedMs < 0) ||
    Number.isNaN(speedKmh) ||
    (speedKmh !== null && speedKmh < 0)
  ) {
    throw new Error('invalid param');
  }

  const now = new Date();

  // const { id, maxAge, maxCount } = item;

  const speed = typeof speedKmh === 'number' ? speedKmh / 3.6 : speedMs;

  const { insertId } = await conn.query(SQL`
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

  if (maxAge) {
    await conn.query(
      SQL`DELETE FROM trackingPoint WHERE deviceId = ${id} AND TIMESTAMPDIFF(SECOND, createdAt, now()) > ${maxAge}`,
    );
  }

  if (maxCount) {
    await conn.query(SQL`
      DELETE t FROM trackingPoint AS t JOIN (
        SELECT id FROM trackingPoint WHERE deviceId = ${id}
          ORDER BY id DESC LIMIT 18446744073709551615 OFFSET ${maxCount + 1}
      ) tlimit ON t.id = tlimit.id
    `);
  }

  const rows = await conn.query(SQL`
    SELECT token FROM trackingAccessToken
      WHERE deviceId = ${id} AND (timeFrom IS NULL OR timeFrom > ${now}) AND (timeTo IS NULL OR timeTo < ${now})
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

  notify('deviceId', String(id));

  return insertId;
}
