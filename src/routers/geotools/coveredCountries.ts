import { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import { assert } from 'typia';
import { pool } from '../../database.js';

export async function coveredCountries(ctx: ParameterizedContext) {
  console.log(ctx.request.body);

  const rows = assert<{ alpha2: string }[]>(
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
  );

  ctx.body = rows.map((row) => row.alpha2);
}
