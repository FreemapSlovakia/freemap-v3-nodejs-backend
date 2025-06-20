import Router from '@koa/router';
import { pointToTile, Tile, tileToGeoJSON } from '@mapbox/tilebelt';
import { bbox } from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import { Feature, MultiPolygon, Polygon } from 'geojson';
import got, { HTTPError } from 'got';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Logger } from 'pino';
import sql from 'sql-template-tag';
import { authenticator } from '../authenticator.js';
import { pool, runInTransaction } from '../database.js';
import { DownloadableMap, downloadableMaps } from '../downloadableMaps.js';
import { getEnv } from '../env.js';
import { bodySchemaValidator } from '../requestValidators.js';

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
      if (!ctx.state.user?.email) {
        ctx.throw(409, 'absent email address');
        return;
      }

      const map = downloadableMaps[ctx.request.body.type];

      if (!map) {
        ctx.throw(400, 'invalid map type');
        return;
      }

      let [{ credits }] = await pool.query(
        sql`SELECT credits FROM user WHERE id = ${ctx.state.user.id} FOR UPDATE`,
      );

      const price = 100; // TODO compute

      credits -= price;

      if (credits < 0) {
        ctx.throw(409, '');
        return;
      }

      pool.query(
        sql`UPDATE user SET credits = ${credits} WHERE id = ${ctx.state.user.id}`,
      );

      const { insertId } = await pool.query(
        sql`INSERT INTO blockedCredit SET amount = ${price}, userId = ${ctx.state.user.id}`,
      );

      (async () => {
        let refund = false;

        try {
          await download(map, ctx.request.body, ctx.log);
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
      })().catch((err) => {
        ctx.log.error({ err }, 'Error during map download cleanup.');
      });

      ctx.status = 204;
    },
  );
}

async function download(map: DownloadableMap, body: any, logger: Logger) {
  const { minZoom, maxZoom, boundary, scale, name, email } = body;

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
      ('type', 'baselayer'),
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

  for (const tile of calculateTiles(boundary, minZoom, maxZoom)) {
    const response = await got(
      map.url
        .replace('{x}', tile[0].toString())
        .replace('{y}', tile[1].toString())
        .replace('{z}', tile[2].toString()) +
        (scale && scale !== 1 ? `@${scale}x` : ''),
      {
        responseType: 'buffer',
        throwHttpErrors: false,
      },
    );

    if (response.statusCode === 200) {
      const [x, y, z] = tile;

      stmt.run(z, x, (1 << z) - 1 - y, response.body);
    } else if (response.statusCode !== 404) {
      throw new HTTPError(response);
    }
  }

  db.close();

  await got.post(
    `https://api.mailgun.net/v3/${getEnv('MAILGIN_DOMAIN')}/messages`,
    {
      username: 'api',
      password: getEnv('MAILGIN_API_KEY'),
      form: {
        from: 'Freemap <noreply@freemap.sk>',
        to: email,
        subject: 'Freemap Map Download',
        text: `Map is ready at ${getEnv('MBTILES_URL_PREFIX')}/${dbName}.mbtiles for 24 hours.`,
      },
    },
  );
}

export function* calculateTiles(
  boundary: Feature<Polygon | MultiPolygon>,
  minZoom: number,
  maxZoom: number,
): Generator<Tile> {
  const bboxExtent = bbox(boundary);

  for (let z = minZoom; z <= maxZoom; z++) {
    const minTile = pointToTile(bboxExtent[0], bboxExtent[3], z);
    const maxTile = pointToTile(bboxExtent[2], bboxExtent[1], z);

    for (let x = minTile[0]; x <= maxTile[0]; x++) {
      for (let y = minTile[1]; y <= maxTile[1]; y++) {
        if (booleanIntersects(boundary, tileToGeoJSON([x, y, z]))) {
          yield [x, y, z];
        }
      }
    }
  }
}
