import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const RowSchema = z.strictObject({ alpha2: z.string() });

export function attachCoveredCountriesHandler(router: RouterInstance) {
  registerPath('/geotools/covered-countries', {
    post: {
      responses: {
        200: {
          content: { 'application/json': { schema: z.array(z.string()) } },
        },
      },
    },
  });

  router.post(
    '/covered-countries',
    acceptValidator('application/geo+json'),
    async (ctx) => {
      ctx.body = RowSchema.array()
        .parse(
          await pool.query(sql`
            WITH poly AS (
              SELECT ST_GeomFromGeoJSON(${ctx.request.body}) AS geom
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
