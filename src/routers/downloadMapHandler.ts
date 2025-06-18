import Router from '@koa/router';
import { pointToTile, Tile, tileToGeoJSON } from '@mapbox/tilebelt';
import { bbox } from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import { Feature, MultiPolygon, Polygon } from 'geojson';
import sql from 'sql-template-tag';
import { blockedCreditIds } from 'src/blockedCredits.js';
import { getEnv } from 'src/env.js';
import { authenticator } from '../authenticator.js';
import { pool, runInTransaction } from '../database.js';
import { bodySchemaValidator } from '../requestValidators.js';

export function attachLoggerHandler(router: Router) {
  router.post(
    '/downloadMap',
    authenticator(true),
    bodySchemaValidator({
      type: 'object',
      required: ['boundary', 'urlTemplate', 'maxZoom'],
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
        sql`INSERT INTO blocked_credit SET amount = ${price}, userId = ${ctx.state.user.id}`,
      );

      blockedCreditIds.add(insertId);

      download(ctx.request.body).catch((err) => {
        ctx.log.error('Error during map download:', err);

        // TODO return blocked credit and notify user
      });

      ctx.status = 204;
    },
  );
}

async function download(body: any) {
  const { type, minZoom, maxZoom, boundary, scale, name, email } = body;

  calculateTiles(boundary, minZoom, maxZoom);

  // send email
  await got.post(
    `https://api.mailgun.net/v3/${getEnv('MAILGIN_DOMAIN')}/messages`,
    {
      username: 'api',
      password: getEnv('MAILGIN_API_KEY'),
      form: {
        from: 'Freemap <noreply@freemap.sk>',
        to: email,
        subject: 'Freemap Map Download',
        text: `Map is readt at: ${url}`,
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
