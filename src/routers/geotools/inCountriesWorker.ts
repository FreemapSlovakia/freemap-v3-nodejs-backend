import Database from 'better-sqlite3';
import { getEnv } from '../../env.js';

const countriesDb = getEnv('COUNTRIES_DB');

const db = new Database(countriesDb, { readonly: true }).loadExtension(
  'mod_spatialite',
);

export default function getCountries(wktPoly: string) {
  return db
    .prepare(
      `WITH geom_input AS (
        SELECT GeomFromText(?, 3857) AS geom
      ),
      bbox AS (
        SELECT
          ST_MinX(geom) AS xmin,
          ST_MaxX(geom) AS xmax,
          ST_MinY(geom) AS ymin,
          ST_MaxY(geom) AS ymax,
          geom
        FROM geom_input
      )
      SELECT DISTINCT alpha2
      FROM countries, bbox
      WHERE ROWID IN (
        SELECT pkid FROM idx_countries_geom
        WHERE xmin < bbox.xmax AND xmax > bbox.xmin
          AND ymin < bbox.ymax AND ymax > bbox.ymin
      )
      AND ST_Intersects(countries.geom, bbox.geom)`,
    )
    .all(wktPoly)
    .map((item) => (item as any).alpha2);
}
