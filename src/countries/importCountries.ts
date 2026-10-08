import {
  type DuckDBBlobValue,
  type DuckDBConnection,
  DuckDBInstance,
} from '@duckdb/node-api';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../database.js';
import { getEnv } from '../env.js';
import { appLogger } from '../logger.js';

const logger = appLogger.child({ module: 'countriesImport' });

const STAC_CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';

// Keeps each polygon cheap for the `ST_Intersects`/`ST_Contains` that follow
// the spatial-index hit; countries are up to ~230k vertices whole.
const MAX_VERTICES = 256;

// The release carries ~270 codes; far fewer means a broken or partial read.
const MIN_CODES = 250;

async function latestRelease(): Promise<string> {
  const res = await fetch(STAC_CATALOG_URL);

  if (!res.ok) {
    throw new Error(`STAC catalog: HTTP ${res.status}`);
  }

  return z.object({ latest: z.string() }).parse(await res.json()).latest;
}

async function openDuckDb(): Promise<DuckDBConnection> {
  const conn = await (await DuckDBInstance.create(':memory:')).connect();

  await conn.run(`INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
    SET s3_region = 'us-west-2';`);

  return conn;
}

/**
 * Rebuilds `country` from Overture Maps' `division_area` (OSM-derived, ODbL):
 * one polygon set per country or dependency code, including Overture's
 * user-assigned `X*` codes for disputed areas. The maritime variant (land plus
 * territorial waters) is used where the code has one, the land one otherwise,
 * so coastal and boat photos still resolve. Polygons are split to at most
 * MAX_VERTICES vertices, then the finished table is swapped in atomically.
 */
async function importCountries() {
  const release = getEnv('OVERTURE_RELEASE', '') || (await latestRelease());

  logger.info(`Importing countries from Overture release ${release}…`);

  const duck = await openDuckDb();

  // The predicate on the hive partition and the subtype column lets DuckDB
  // fetch only the matching row groups, a few hundred MB, not the whole theme.
  await duck.run(`CREATE TABLE area AS
    SELECT country, class, geometry
    FROM read_parquet(
      's3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*',
      hive_partitioning = 1
    )
    WHERE subtype IN ('country', 'dependency')`);

  const result = await duck.stream(`
    SELECT lower(country) AS alpha2,
      ST_AsWKB(unnest(ST_Dump(ST_Subdivide(geometry, ${MAX_VERTICES}))).geom) AS wkb
    FROM area a
    WHERE class = 'maritime' OR NOT EXISTS (
      SELECT 1 FROM area m WHERE m.country = a.country AND m.class = 'maritime'
    )`);

  await pool.query(sql`DROP TABLE IF EXISTS country_new`);

  await pool.query(sql`CREATE TABLE country_new (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    alpha2 CHAR(2) CHARSET ascii NOT NULL,
    geom GEOMETRY NOT NULL
  ) ENGINE=InnoDB`);

  let rows = 0;

  for await (const chunk of result.yieldRows()) {
    await pool.batch(
      'INSERT INTO country_new (alpha2, geom) VALUES (?, ST_GeomFromWKB(?, 4326))',
      chunk.map(([alpha2, wkb]) => [
        z.string().length(2).parse(alpha2),
        Buffer.from((wkb as DuckDBBlobValue).bytes),
      ]),
    );

    rows += chunk.length;
  }

  duck.closeSync();

  const [{ codes }] = z
    .array(z.object({ codes: z.number() }))
    .parse(
      await pool.query(
        sql`SELECT COUNT(DISTINCT alpha2) AS codes FROM country_new`,
      ),
    );

  if (codes < MIN_CODES) {
    throw new Error(
      `Import built only ${codes} country codes (${rows} polygons) — refusing to swap it in.`,
    );
  }

  await pool.query(sql`ALTER TABLE country_new
    ADD SPATIAL INDEX country_geom_spx (geom)`);

  // RENAME needs a source table; on a fresh database there is none yet.
  await pool.query(sql`CREATE TABLE IF NOT EXISTS country (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    alpha2 CHAR(2) CHARSET ascii NOT NULL,
    geom GEOMETRY NOT NULL,
    SPATIAL INDEX country_geom_spx (geom)
  ) ENGINE=InnoDB`);

  await pool.query(sql`DROP TABLE IF EXISTS country_old`);

  await pool.query(sql`RENAME TABLE
    country TO country_old,
    country_new TO country`);

  await pool.query(sql`DROP TABLE country_old`);

  // The picture triggers only resolve a country on insert or when the location
  // moves, so existing photos would keep codes from the replaced borders.
  await pool.query(sql`UPDATE picture p SET p.country = (
    SELECT c.alpha2
    FROM country c
    WHERE MBRContains(c.geom, p.location) AND ST_Contains(c.geom, p.location)
    LIMIT 1
  )`);

  logger.info(
    `Countries import done: ${codes} codes in ${rows} polygons from ${release}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  importCountries()
    .then(() => pool.end())
    .catch((err) => {
      logger.error(err);

      process.exit(1);
    });
}
