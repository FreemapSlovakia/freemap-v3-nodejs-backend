import Router from '@koa/router';
import { pointToTile, Tile, tileToGeoJSON } from '@mapbox/tilebelt';
import { bbox } from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import got, { HTTPError } from 'got';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Logger } from 'pino';
import sql from 'sql-template-tag';
import { authenticator } from '../authenticator.js';
import { pool, runInTransaction } from '../database.js';
import { DownloadableMap, downloadableMaps } from '../downloadableMaps.js';
import { getEnv } from '../env.js';
import { bodySchemaValidator } from '../requestValidators.js';

const CONCURRENCY = 8;

export function attachDownloadMapHandler(router: Router) {
  router.post(
    '/downloadMap',
    authenticator(true),
    bodySchemaValidator({
      type: 'object',
      required: ['type', 'minZoom', 'maxZoom', 'boundary', 'name', 'email'],
      properties: {
        type: {
          type: 'string',
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
        ({ type }) => type === ctx.request.body.type,
      );

      if (!map) {
        ctx.throw(400, 'invalid map type');
        return;
      }

      let [{ credits }] = await pool.query(
        sql`SELECT credits FROM user WHERE id = ${user.id} FOR UPDATE`,
      );

      const { minZoom, maxZoom, boundary, scale, name, email } =
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

      (async () => {
        let refund = false;

        try {
          await download(
            map,
            minZoom,
            maxZoom,
            boundary,
            scale,
            name,
            email,
            totalTiles,
            ctx.log,
          );
        } catch (err) {
          ctx.log.error({ err }, 'Error during map download.');

          refund = true;
        }

        const conn = await pool.getConnection();

        try {
          await conn.beginTransaction();

          if (refund) {
            await conn.query(sql`UPDATE user SET credits = credits + ${price}`);
          }

          await conn.query(
            sql`DELETE FROM blockedCredit WHERE id = ${insertId}`,
          );

          await conn.commit();
        } finally {
          conn.release();
        }

        ctx.log.error('Map download complete.');
      })().catch((err) => {
        ctx.log.error({ err }, 'Error during map download cleanup.');
      });

      ctx.status = 204;
    },
  );
}

async function download(
  map: DownloadableMap,
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
  const dbName = name.trim() ? name.trim() + '-' + timestamp : timestamp;
  const db = new DatabaseSync(getEnv('MBTILES_DIR') + `/${dbName}.mbtiles`);

  db.exec(`
    PRAGMA journal_mode = WAL;

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
      ('attribution', 'TODO')`;

  db.prepare(combo.sql).run(...(combo.values as SQLInputValue[]));

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)`,
  );

  const it = calculateTiles(boundary, minZoom, maxZoom);

  let downloadedCount = 0;
  let logTs = 0;

  async function downloadTile(tile: Tile) {
    const response = await got(
      map.url
        .replace('{x}', tile[0].toString())
        .replace('{y}', tile[1].toString())
        .replace('{z}', tile[2].toString()) +
        (scale && map.extraScales?.includes(scale) ? `@${scale}x` : ''),
      {
        responseType: 'buffer',
        throwHttpErrors: false,
      },
    );

    downloadedCount++;

    if (Date.now() - logTs > 1_000) {
      logger.info(
        { done: downloadedCount, total: totalTiles },
        'Downloaded tiles: %d/%d',
        downloadedCount,
        totalTiles,
      );

      logTs = Date.now();
    }

    if (response.statusCode === 200) {
      const [x, y, z] = tile;

      stmt.run(z, x, (1 << z) - 1 - y, response.body);
    } else if (response.statusCode !== 404) {
      throw new HTTPError(response);
    }
  }

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

  logger.info('Map download completed, sending email notification.');

  await got.post(
    `https://api.mailgun.net/v3/${getEnv('MAILGIN_DOMAIN')}/messages`,
    {
      username: 'api',
      password: getEnv('MAILGIN_API_KEY'),
      form: {
        from: 'Freemap <noreply@freemap.sk>',
        to: email,
        subject: 'Freemap Map Download',
        text: `Your map is ready at ${getEnv('MBTILES_URL_PREFIX')}/${dbName}.mbtiles for 24 hours.`,
      },
    },
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
