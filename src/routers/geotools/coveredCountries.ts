import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { GeoJSONGeometrySchema } from 'zod-geojson';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const RowSchema = z.strictObject({ alpha2: z.string() });

// The body is either a bare geometry or a `Feature` wrapping one; both are
// reduced to the geometry, which is what `ST_GeomFromGeoJSON` takes. Only the
// geometry of a `Feature` is validated - `properties` and the rest never reach
// the query, and requiring them would reject bodies the handler used to accept.
const BodySchema = z.union([
  GeoJSONGeometrySchema,
  z
    .looseObject({
      type: z.literal('Feature'),
      geometry: GeoJSONGeometrySchema,
    })
    .transform((feature) => feature.geometry),
]);

export function attachCoveredCountriesHandler(router: RouterInstance) {
  registerPath('/geotools/covered-countries', {
    post: {
      summary: 'Get countries covered by a geometry',
      description:
        'The body is a GeoJSON geometry, or a Feature wrapping one. ' +
        'Anything else is rejected with 400.',
      tags: ['geotools'],
      // No `requestBody` schema: `GeoJSONGeometrySchema` recurses through
      // `GeometryCollection.geometries`, whose getter returns a fresh schema on
      // every access, so zod-openapi never sees a cycle and overflows the stack
      // while rendering it - taking all of `/documentation` down with it.
      responses: {
        200: {
          content: { 'application/json': { schema: z.array(z.string()) } },
        },
        400: {},
      },
    },
  });

  router.post(
    '/covered-countries',
    acceptValidator('application/geo+json'),
    async (ctx) => {
      let geometry;

      try {
        geometry = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      // Serialize explicitly: the mariadb connector encodes any object whose
      // `type` names a GeoJSON geometry as a native geometry parameter, which
      // `ST_GeomFromGeoJSON` then refuses.
      const geoJson = JSON.stringify(geometry);

      ctx.body = RowSchema.array()
        .parse(
          await pool.query<unknown>(sql`
            WITH poly AS (
              SELECT ST_GeomFromGeoJSON(${geoJson}) AS geom
            )
            SELECT DISTINCT c.alpha2
            FROM country c
            CROSS JOIN poly p
            WHERE MBRIntersects(c.geom, p.geom) AND ST_Intersects(c.geom, p.geom)`),
        )
        .map((row) => row.alpha2);
    },
  );
}
