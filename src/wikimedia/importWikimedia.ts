import { createGunzip } from 'node:zlib';
import got from 'got';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../database.js';
import { getEnv, getEnvInteger } from '../env.js';
import { appLogger } from '../logger.js';
import { isPhotoTitle, makeBitset } from './pageTitleFilter.js';
import { type SqlValue, streamDumpRows } from './sqlDumpParser.js';

const logger = appLogger.child({ module: 'wikimediaImport' });

const GEO_TAGS_URL = getEnv(
  'WIKIMEDIA_GEO_TAGS_DUMP_URL',
  'https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-geo_tags.sql.gz',
);

const PAGE_URL = getEnv(
  'WIKIMEDIA_PAGE_DUMP_URL',
  'https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-page.sql.gz',
);

// Rows per multi-row INSERT.
const BATCH_SIZE = getEnvInteger('WIKIMEDIA_IMPORT_BATCH_SIZE', 5000);

// Rows per transaction. The load is disk-bound on InnoDB's redo-log fsync (one
// per commit with the default innodb_flush_log_at_trx_commit=1), so committing
// in large chunks — rather than per batch — cuts the number of fsyncs ~100×.
const COMMIT_ROWS = getEnvInteger('WIKIMEDIA_IMPORT_COMMIT_ROWS', 200_000);

const FILE_NAMESPACE = 6;

/** Decompressed byte stream of a `.sql.gz` dump, with download errors forwarded. */
function dumpStream(url: string) {
  const src = got.stream(url, { retry: { limit: 2 } });
  const gunzip = createGunzip();

  src.on('error', (err) => gunzip.destroy(err));

  return src.pipe(gunzip);
}

function columnIndex(columns: string[]): Record<string, number> {
  const idx: Record<string, number> = {};

  columns.forEach((c, i) => {
    idx[c] = i;
  });

  return idx;
}

type Bitset = ReturnType<typeof makeBitset>;

/**
 * Camera-type, primary, Earth geo tags → `[pageId, lat, lon]` rows. Each
 * emitted pageId is also recorded in `seen` so the page pass can filter titles
 * to just the geotagged subset.
 */
async function* geoTagRows(seen: Bitset): AsyncGenerator<SqlValue[]> {
  let idx: Record<string, number> | null = null;

  // gt_type is column index 7, so 8 fields cover everything we read.
  for await (const { columns, values } of streamDumpRows(
    dumpStream(GEO_TAGS_URL),
    'geo_tags',
    { maxFields: 8 },
  )) {
    if (!idx) {
      idx = columnIndex(columns);
    }

    if (
      values[idx['gt_globe']] !== 'earth' ||
      Number(values[idx['gt_primary']]) !== 1 ||
      values[idx['gt_type']] !== 'camera'
    ) {
      continue;
    }

    const pageId = values[idx['gt_page_id']];
    const lat = values[idx['gt_lat']];
    const lon = values[idx['gt_lon']];

    if (pageId == null || lat == null || lon == null) {
      continue;
    }

    seen.set(Number(pageId));

    yield [pageId, lat, lon];
  }
}

/**
 * File-namespace pages that are geotagged (`seen`) AND whose title is a
 * photographic raster (`PHOTO_EXT`) → `[pageId]` rows. This is what drops the
 * non-photo bulk uploads (orthophoto/map `.tif` tiles, PDFs, SVGs, …).
 */
async function* pageKeepRows(seen: Bitset): AsyncGenerator<SqlValue[]> {
  let idx: Record<string, number> | null = null;

  // page_title is column index 2, so 3 fields suffice.
  for await (const { columns, values } of streamDumpRows(
    dumpStream(PAGE_URL),
    'page',
    { maxFields: 3 },
  )) {
    if (!idx) {
      idx = columnIndex(columns);
    }

    if (Number(values[idx['page_namespace']]) !== FILE_NAMESPACE) {
      continue;
    }

    const pageId = values[idx['page_id']];
    const title = values[idx['page_title']];

    if (
      pageId == null ||
      typeof title !== 'string' ||
      !seen.has(Number(pageId)) ||
      !isPhotoTitle(title)
    ) {
      continue;
    }

    yield [pageId];
  }
}

/**
 * Drain `source` into a single connection using multi-row inserts wrapped in
 * large transactions (committed every COMMIT_ROWS rows). Sequential on purpose:
 * the load is disk-bound, so concurrent commits only contend. Returns the number
 * of rows inserted.
 */
async function insertAll(
  source: AsyncIterable<SqlValue[]>,
  insertSql: string,
): Promise<number> {
  const conn = await pool.getConnection();

  let count = 0;
  let batch: SqlValue[][] = [];
  let sinceCommit = 0;

  const flush = async () => {
    if (batch.length === 0) {
      return;
    }

    await conn.batch(insertSql, batch);
    batch = [];
  };

  try {
    // Staging tables are throwaway, so trade durability/checks for speed.
    await conn.query('SET SESSION unique_checks = 0');
    await conn.query('SET SESSION foreign_key_checks = 0');
    await conn.beginTransaction();

    for await (const row of source) {
      batch.push(row);
      count++;
      sinceCommit++;

      if (batch.length >= BATCH_SIZE) {
        await flush();
      }

      if (sinceCommit >= COMMIT_ROWS) {
        await flush();
        await conn.commit();
        await conn.beginTransaction();
        sinceCommit = 0;
      }
    }

    await flush();
    await conn.commit();
  } finally {
    conn.release();
  }

  return count;
}

export async function importWikimedia(): Promise<void> {
  const started = Date.now();

  await pool.query(sql`DROP TABLE IF EXISTS wm_stage`);
  await pool.query(sql`DROP TABLE IF EXISTS wm_keep`);
  await pool.query(sql`DROP TABLE IF EXISTS wikimediaPicture_new`);

  // Heap staging table — no primary key so the (page-id-random) geo_tags rows
  // append sequentially instead of thrashing a clustered index.
  await pool.query(sql`CREATE TABLE wm_stage (
    pageId INT UNSIGNED NOT NULL,
    lat DOUBLE NOT NULL,
    lon DOUBLE NOT NULL
  ) ENGINE=InnoDB`);

  // Geotagged pageIds whose file is a real photo (page dump is page_id-ordered,
  // so this PK stays sequential).
  await pool.query(sql`CREATE TABLE wm_keep (
    pageId INT UNSIGNED NOT NULL PRIMARY KEY
  ) ENGINE=InnoDB`);

  // Bit-set of geotagged pageIds so the page pass only considers relevant rows.
  const seen = makeBitset();

  logger.info('Streaming geo_tags dump…');

  const geoCount = await insertAll(
    geoTagRows(seen),
    'INSERT INTO wm_stage (pageId, lat, lon) VALUES (?, ?, ?)',
  );

  logger.info(
    `Loaded ${geoCount} camera geo tags. Streaming page dump for photo titles…`,
  );

  const keepCount = await insertAll(
    pageKeepRows(seen),
    'INSERT IGNORE INTO wm_keep (pageId) VALUES (?)',
  );

  logger.info(
    `${keepCount} geotagged files are photos (of ${geoCount}). Building final table…`,
  );

  // One sorted index build — cheap versus maintaining it during the load.
  await pool.query(
    sql`ALTER TABLE wm_stage ADD INDEX wm_stage_pageId (pageId)`,
  );

  // Final table: inner-join keeps only photo pageIds, INSERT IGNORE dedups on
  // the pageId PK, ORDER BY pageId keeps that insert sequential. Spatial index
  // is added once afterwards.
  await pool.query(sql`CREATE TABLE wikimediaPicture_new (
    pageId INT UNSIGNED NOT NULL PRIMARY KEY,
    location POINT NOT NULL
  ) ENGINE=InnoDB`);

  await pool.query(sql`INSERT IGNORE INTO wikimediaPicture_new (pageId, location)
    SELECT s.pageId, POINT(s.lon, s.lat)
    FROM wm_stage s JOIN wm_keep k ON k.pageId = s.pageId
    ORDER BY s.pageId`);

  // Free the staging tables before the (temp-space-hungry) spatial index build —
  // keeps peak disk usage down on a nearly-full volume.
  await pool.query(sql`DROP TABLE wm_stage, wm_keep`);

  logger.info('Building spatial index…');

  await pool.query(sql`ALTER TABLE wikimediaPicture_new
    ADD SPATIAL INDEX wikimediaPicture_location_spx (location)`);

  // Atomically swap the freshly built table in.
  await pool.query(sql`CREATE TABLE IF NOT EXISTS wikimediaPicture (
    pageId INT UNSIGNED NOT NULL PRIMARY KEY,
    location POINT NOT NULL,
    SPATIAL INDEX wikimediaPicture_location_spx (location)
  ) ENGINE=InnoDB`);

  await pool.query(sql`DROP TABLE IF EXISTS wikimediaPicture_old`);

  await pool.query(sql`RENAME TABLE
    wikimediaPicture TO wikimediaPicture_old,
    wikimediaPicture_new TO wikimediaPicture`);

  await pool.query(sql`DROP TABLE wikimediaPicture_old`);

  const [{ cnt }] = z
    .array(z.object({ cnt: z.number() }))
    .parse(await pool.query(sql`SELECT COUNT(*) AS cnt FROM wikimediaPicture`));

  logger.info(
    `Wikimedia import done: ${cnt} photos live (${Math.round((Date.now() - started) / 1000)}s).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  importWikimedia()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err);

      process.exit(1);
    });
}
