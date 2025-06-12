import net from 'net';
import sql, { empty } from 'sql-template-tag';
import { pool } from './database.js';
import { storeTrackPoint } from './deviceTracking.js';
import { getEnvInteger } from './env.js';
import { appLogger } from './logger.js';

const logger = appLogger.child({ module: 'socketDeviceTracking' });

let id = 0;

export function startSocketDeviceTracking() {
  const port = getEnvInteger('TRACKING_SOCKET_PORT', 0);

  if (!port) {
    return null;
  }

  const server = net.createServer((connection) => {
    let imei: string;

    const connLogger = logger.child({ id });

    id++;

    connLogger.info(
      { remoteAddress: connection.remoteAddress },
      'Connection opened.',
    );

    connection.on('data', async (data) => {
      let conn;

      try {
        const msg = data.toString();

        connLogger.debug(`Data: ${msg}`);

        const result = /^\((.{12})([AB][A-Z]\d\d)(.*).*\)$/.exec(msg);

        if (!result) {
          connection.end();
          return;
        }

        const [, deviceId, command, args] = result;

        connLogger.debug({ deviceId, command, args }, 'Received command.');

        conn = await pool.getConnection();

        conn.beginTransaction();

        const [item] = await conn.query(
          sql`SELECT id, maxCount, maxAge FROM trackingDevice WHERE token IN (${`did:${deviceId}`}${imei ? sql`, ${`imei:${imei}`}` : empty})`,
        );

        if (!item) {
          connection.end();
          return;
        }

        if (command === 'BR00') {
          // args: 200313A4842.4669N02114.1758E014.4174559353.24,00000000L00000000
          // args: 200313 (date) A (availability) 48 42.4669 N (lat) 021 14.1758 E (lon) 014.4 (speed) 174559 (time) 353.24 (orientation) , (comma) 00000000 (io_state) L (mile post) 00000000 (mile data)

          const indexes = [
            2, 2, 2, 1, 2, 7, 1, 3, 7, 1, 5, 2, 2, 2, 6, 8, 1, 8,
          ];

          const slices = split(
            // my device has there some comma which is in no specs I saw so far
            args.replace(/,/g, ''),
            indexes,
          );

          const [
            yy,
            mm,
            dd,
            avail,
            latd,
            latm,
            lati,
            lond,
            lonm,
            loni,
            speed,
            hh,
            nn,
            ss,
            orientation,
            // ioState,
            // milepost,
            // mileData,
          ] = slices;

          if (avail !== 'A') {
            return;
          }

          const date = new Date(
            Number(`20${yy}`),
            Number(mm) - 1,
            Number(dd),
            Number(hh),
            Number(nn),
            Number(ss),
          );

          const lat =
            (lati === 'S' ? -1 : 1) * (Number(latd) + Number(latm) / 60);

          const lon =
            (loni === 'W' ? -1 : 1) * (Number(lond) + Number(lonm) / 60);

          connLogger.debug(
            {
              avail, // A - valid, V - invalid
              date,
              lat,
              lon,
              speed: Number(speed),
              orientation: Number(orientation),
            },
            'Got GPS data.',
          );

          await storeTrackPoint(
            conn,
            item.id,
            item.maxAge,
            item.maxCount,
            Number(speed),
            null,
            lat,
            lon,
            null,
            null,
            null,
            Number(orientation),
            null,
            null,
            null,
            date,
          );
        } else if (command === 'BP00') {
          imei = args.slice(0, 15);
          // args: 352672101572147HSOP4F
          // args: 352672101572147 (imei) HSOP4F

          connection.write(`${deviceId}AP01HSO${args.slice(19)}`);
        }

        conn.commit();
      } finally {
        if (conn) {
          conn.release();
        }
      }
    });

    connection.on('error', (err) => {
      connLogger.error({ err }, 'Socket error.');
    });

    connection.on('end', () => {
      connLogger.debug('Socket ended.');
    });

    connection.on('close', (closeResult) => {
      connLogger.debug({ closeResult }, 'Socket closed.');
    });
  });

  function split(string: string, indexes: number[]) {
    const slices = [];
    let prevIndex = 0;
    let currIndex = 0;

    for (const index of indexes) {
      currIndex += index;
      slices.push(string.slice(prevIndex, currIndex));
      prevIndex = currIndex;
    }

    return slices;
  }

  server.listen(Number(port), () => {
    logger.info(`Device tracking socket listening on port ${port}.`);
  });

  return server;
}
