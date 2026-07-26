import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { isSqlMissingTableError, pool } from '../../database.js';
import { appLogger } from '../../logger.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const RowSchema = z.strictObject({ alpha2: z.string() });

const logger = appLogger.child({ module: 'coveredCountries' });

export function attachCoveredCountriesHandler(router: RouterInstance) {
  registerPath('/geotools/covered-countries', {
    post: {
      summary: 'Get countries covered by a geometry',
      tags: ['geotools'],
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
      let rows: unknown;

      try {
        rows = await pool.query<unknown>(sql`
          WITH poly AS (
            SELECT ST_GeomFromGeoJSON(${ctx.request.body}) AS geom
          )
          SELECT DISTINCT c.alpha2
          FROM country c
          CROSS JOIN poly p
          WHERE MBRIntersects(c.geom, p.geom) AND ST_Intersects(c.geom, p.geom)`);
      } catch (err) {
        if (!isSqlMissingTableError(err)) {
          throw err;
        }

        // The country table is populated externally and is optional; without it
        // nothing is covered, same as the picture country triggers.
        logger.warn('No country table; returning no covered countries.');

        ctx.body = [];

        return;
      }

      ctx.body = RowSchema.array()
        .parse(rows)
        .map((row) => row.alpha2);
    },
  );
}
