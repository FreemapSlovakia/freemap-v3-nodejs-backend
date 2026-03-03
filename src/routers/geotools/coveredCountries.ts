import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { assert } from 'typia';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachCoveredCountriesHandler(router: RouterInstance) {
  router.post(
    '/covered-countries',
    acceptValidator('application/geo+json'),
    async (ctx) => {
      ctx.body = assert<{ alpha2: string }[]>(
        await pool.query(
          sql`
          WITH poly AS (
            SELECT ST_GeomFromGeoJSON(${ctx.request.body}) AS geom
          )
          SELECT DISTINCT c.alpha2
          FROM country c
          CROSS JOIN poly p
          WHERE MBRIntersects(c.geom, p.geom) AND ST_Intersects(c.geom, p.geom)`,
        ),
      ).map((row) => row.alpha2);
    },
  );
}
