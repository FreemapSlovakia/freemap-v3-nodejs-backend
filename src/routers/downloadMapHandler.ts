import Router from '@koa/router';
import { pointToTile, Tile, tileToGeoJSON } from '@mapbox/tilebelt';
import { bbox } from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import center from '@turf/center';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { unlink } from 'node:fs/promises';
import { ClientHttp2Session, connect } from 'node:http2';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Logger } from 'pino';
import sql from 'sql-template-tag';
import { authenticator } from '../authenticator.js';
import { pool, runInTransaction } from '../database.js';
import { DownloadableMap, downloadableMaps } from '../downloadableMaps.js';
import { getEnv } from '../env.js';
import { appLogger } from '../logger.js';
import { sendMail } from '../mailer.js';
import { bodySchemaValidator } from '../requestValidators.js';

const CONCURRENCY = 8;

export function attachDownloadMapHandler(router: Router) {
  router.post(
    '/downloadMap',
    authenticator(true),
    bodySchemaValidator({
      type: 'object',
      required: [
        'map',
        'minZoom',
        'maxZoom',
        'boundary',
        'name',
        'email',
        'format',
      ],
      properties: {
        map: {
          type: 'string',
        },
        format: {
          type: 'string',
          enum: ['mbtiles', 'sqlitedb'],
        },
        minZoom: {
          type: 'number',
          minimum: 0,
        },
        maxZoom: {
          type: 'number',
          minimum: 0,
          maximum: 20,
        },
        boundary: {
          type: 'object',
          required: ['type', 'geometry'],
          properties: {
            type: { type: 'string', enum: ['Feature'] },
            geometry: { $ref: '#/definitions/GeoJSONGeometry' },
            properties: { type: 'object' },
          },
        },
        name: {
          type: 'string',
        },
        email: {
          type: 'string',
          format: 'email',
        },
        scale: {
          type: 'number',
          minimum: 1,
          maximum: 3,
        },
      },
      definitions: {
        PolygonCoords: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'array',
              items: [
                {
                  type: 'number',
                  minimum: -180,
                  maximum: 180,
                },
                {
                  type: 'number',
                  minimum: -90,
                  maximum: 90,
                },
              ],
            },
          },
        },
        GeoJSONGeometry: {
          oneOf: [
            {
              type: 'object',
              required: ['type', 'coordinates'],
              properties: {
                type: { type: 'string', enum: ['Polygon'] },
                coordinates: { $ref: '#/definitions/PolygonCoords' },
              },
            },
            {
              type: 'object',
              required: ['type', 'coordinates'],
              properties: {
                type: { type: 'string', enum: ['MultiPolygon'] },
                coordinates: {
                  type: 'array',
                  items: { $ref: '#/definitions/PolygonCoords' },
                },
              },
            },
          ],
        },
      },
    }),
    runInTransaction(),
    async (ctx) => {
      const user = ctx.state.user!;

      const map = downloadableMaps.find(
        ({ type }) => type === ctx.request.body.map,
      );

      if (!map) {
        ctx.throw(400, 'invalid map');
        return;
      }

      let [{ credits }] = await pool.query(
        sql`SELECT credits FROM user WHERE id = ${user.id} FOR UPDATE`,
      );

      const { minZoom, maxZoom, boundary, scale, name, email, format } =
        ctx.request.body;

      let totalTiles = 0;

      const it = calculateTiles(boundary, minZoom, maxZoom);

      while (!it.next().done) {
        totalTiles++;
      }

      const price = Math.ceil((totalTiles / 1_000_000) * map.creditsPerMTile);

      credits -= price;

      if (credits < 0) {
        ctx.throw(409, 'not enough credit');
        return;
      }

      pool.query(
        sql`UPDATE user SET credits = ${credits} WHERE id = ${user.id}`,
      );

      const { insertId } = await pool.query(
        sql`INSERT INTO blockedCredit SET amount = ${price}, userId = ${user.id}`,
      );

      const logger = appLogger.child({
        module: 'downloadMap',
        reqId: ctx.reqId,
      });

      (async () => {
        let refund = false;

        try {
          await download(
            map,
            format,
            minZoom,
            maxZoom,
            boundary,
            scale,
            name,
            email,
            totalTiles,
            logger,
          );
        } catch (err) {
          logger.error(
            { err },
            'Error during map download, sending email notification.',
          );

          await sendMail(
            email,
            'Freemap Map Download Error',
            'An error occurred during your map download. ' +
              'Your credits have been refunded. ' +
              'Please try again later or contact support if the problem persists.',
          );

          refund = true;
        }

        const conn = await pool.getConnection();

        try {
          await conn.beginTransaction();

          if (refund) {
            await conn.query(
              sql`UPDATE user SET credits = credits + ${price} WHERE id = ${user.id}`,
            );
          }

          await conn.query(
            sql`DELETE FROM blockedCredit WHERE id = ${insertId}`,
          );

          await conn.commit();
        } finally {
          conn.release();
        }

        logger.info('Map download complete.');
      })().catch((err) => {
        logger.error({ err }, 'Error during map download cleanup.');
      });

      ctx.status = 204;
    },
  );
}

async function download(
  map: DownloadableMap,
  format: 'mbtiles' | 'sqlitedb',
  minZoom: number,
  maxZoom: number,
  boundary: Feature<Polygon | MultiPolygon>,
  scale: number | undefined,
  name: string,
  email: string,
  totalTiles: number,
  logger: Logger,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  const dbName = safeName ? safeName + '-' + timestamp : timestamp;
  const filename = getEnv('MBTILES_DIR') + `/${dbName}.${format}`;
  const db = new DatabaseSync(filename);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = WAL;
  `);

  const cntr = center(boundary);

  if (format === 'mbtiles') {
    db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      name TEXT,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tiles (
      zoom_level INTEGER,
      tile_column INTEGER,
      tile_row INTEGER,
      tile_data BLOB,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS metadata_index ON metadata (name);
  `);

    const combo = sql`INSERT INTO metadata (name, value) VALUES
      ('name', ${name}),
      ('format', 'jpg'),
      ('type', ${map.overlay ? 'overlay' : 'baselayer'}),
      ('version', '1.0'),
      ('description', 'Downloaded map tiles from www.freemap.sk'),
      ('minzoom', ${minZoom}),
      ('maxzoom', ${maxZoom}),
      ('bounds', ${bbox(boundary).join(',')}),
      ('attribution', ${map.attribution})`;

    db.prepare(combo.sql).run(...(combo.values as SQLInputValue[]));
  } else if (format === 'sqlitedb') {
    db.exec(
      `
        CREATE TABLE tiles (x INTEGER, y INTEGER, z INTEGER, s INTEGER, image BLOB, PRIMARY KEY (x, y, z, s));
        CREATE TABLE info (minzoom INTEGER, maxzoom INTEGER, tilesize INTEGER, center_x DOUBLE, center_y DOUBLE, zooms TEXT, provider INTEGER);
      `,
    );

    const min = 17 - maxZoom;
    const max = 17 - minZoom;

    const zooms = Array.from({ length: max - min + 1 }, (_, i) => max - i).join(
      ',',
    );

    const combo = sql`
      INSERT INTO info (minzoom, maxzoom, tilesize, center_x, center_y, zooms, provider)
        VALUES (${min}, ${max}, ${256 * (scale ?? 1)}, ${cntr.geometry.coordinates[1]}, ${cntr.geometry.coordinates[0]}, ${zooms}, 0)
    `;

    db.prepare(combo.sql).run(...(combo.values as SQLInputValue[]));
  } else {
    throw new Error('Unsupported format: ' + format);
  }

  const stmt = db.prepare(
    format === 'mbtiles'
      ? `INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)`
      : `INSERT INTO tiles (z, x, y, image, s) VALUES (?, ?, ?, ?, 0)`,
  );

  const it = calculateTiles(boundary, minZoom, maxZoom);

  let downloadedCount = 0;
  let logTs = 0;
  let closing = false;

  let client!: ClientHttp2Session;

  const handleGoaway = () => {
    if (!closing) {
      client = connect(new URL(map.url).origin);
      client.once('goaway', handleGoaway);
    }
  };

  handleGoaway();

  async function downloadTile(tile: Tile) {
    const [x, y, z] = tile;

    const url = new URL(
      map.url
        .replace('{x}', x.toString())
        .replace('{y}', y.toString())
        .replace('{z}', z.toString()) +
        (scale && map.extraScales?.includes(scale) ? `@${scale}x` : ''),
    );

    let buffer: Buffer<ArrayBufferLike>;

    for (let i = 0; ; i++) {
      try {
        buffer = await new Promise<Buffer>((resolve, reject) => {
          const req = client.request({
            ':path': url.pathname + url.search,
            ':method': 'GET',
          });

          req.on('response', (headers) => {
            const statusCode = Number(headers[':status']);

            if (statusCode !== 200 && statusCode !== 404) {
              reject(new Error(`Unexpected status code: ${statusCode}`));
              req.close();
            }
          });

          const chunks: Buffer[] = [];

          req.on('data', (chunk) => chunks.push(chunk));

          req.on('end', () => {
            resolve(Buffer.concat(chunks));
          });

          req.on('error', (err) => {
            reject(err);
          });

          req.end();
        });

        break;
      } catch (err) {
        if (
          i < 5 &&
          err instanceof Error &&
          'code' in err &&
          typeof err.code === 'string' &&
          [
            'ERR_HTTP2_STREAM_ERROR',
            'ERR_HTTP2_INVALID_SESSION',
            'ERR_HTTP2_GOAWAY_SESSION',
          ].includes(err.code)
        ) {
          logger.warn(
            { code: err.code },
            err.code + '; retrying download (%d/%d)',
            i + 1,
            5,
          );

          await new Promise((resolve) => setTimeout(resolve, i * 100));
        } else {
          throw err;
        }
      }
    }

    downloadedCount++;

    if (Date.now() - logTs > 1_000) {
      logger.info('Downloaded tiles: %d/%d', downloadedCount, totalTiles);

      logTs = Date.now();
    }

    if (format === 'mbtiles') {
      stmt.run(z, x, (1 << z) - 1 - y, buffer);
    } else {
      stmt.run(17 - z, x, y, buffer);
    }
  }

  try {
    const active: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      const { done, value } = it.next();

      if (done) {
        break;
      }

      active.push(downloadTile(value));
    }

    while (active.length) {
      const finishedIndex = await Promise.race(
        active.map((p, idx) => p.then(() => idx)),
      );

      active.splice(finishedIndex, 1);

      const { done, value } = it.next();

      if (!done) {
        active.push(downloadTile(value));
      }
    }

    db.close();
  } catch (err) {
    db.close();

    await unlink(filename);

    throw err;
  } finally {
    closing = true;

    client.close();
  }

  logger.info('Map download successful, sending email notification.');

  await sendMail(
    email,
    'Freemap Map Download',
    `Your map is ready at ${getEnv('MBTILES_URL_PREFIX')}/${encodeURIComponent(dbName)}.${format} for 24 hours.`,
  );
}

export function* calculateTiles(
  boundary: Feature<Polygon | MultiPolygon>,
  minZoom: number,
  maxZoom: number,
) {
  const bboxExtent = bbox(boundary);

  for (let z = minZoom; z <= maxZoom; z++) {
    const minTile = pointToTile(bboxExtent[0], bboxExtent[3], z);
    const maxTile = pointToTile(bboxExtent[2], bboxExtent[1], z);

    for (let x = minTile[0]; x <= maxTile[0]; x++) {
      for (let y = minTile[1]; y <= maxTile[1]; y++) {
        if (booleanIntersects(boundary, tileToGeoJSON([x, y, z]))) {
          yield [x, y, z] as Tile;
        }
      }
    }
  }
}
