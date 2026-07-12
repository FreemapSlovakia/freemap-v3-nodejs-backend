import { createGunzip } from 'node:zlib';
import got from 'got';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { pool } from '../database.js';
import { getEnv, getEnvInteger } from '../env.js';
import { appLogger } from '../logger.js';
import {
  isPhotoTitle,
  makeBitset,
  makeStringBitset,
} from './pageTitleFilter.js';
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

const IMAGE_URL = getEnv(
  'WIKIMEDIA_IMAGE_DUMP_URL',
  'https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-image.sql.gz',
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

type StringBitset = ReturnType<typeof makeStringBitset>;

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
 * photographic raster (`PHOTO_EXT`) → `[pageId, title]` rows. This is what drops
 * the non-photo bulk uploads (orthophoto/map `.tif` tiles, PDFs, SVGs, …). Each
 * kept title is also recorded in `titleBits` so the image pass can pre-filter
 * the (title-keyed) `image` dump to just this subset.
 */
async function* pageKeepRows(
  seen: Bitset,
  titleBits: StringBitset,
): AsyncGenerator<SqlValue[]> {
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

    titleBits.set(title);

    yield [pageId, title];
  }
}

const DATE_TIME_ORIGINAL_RE =
  /"DateTimeOriginal":"(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})"/;

const IMG_TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * Assemble a MySQL `DATETIME` literal from string parts, or return null when
 * they don't form a real calendar instant (rejects the `0000:00:00`, absurd
 * years and impossible days that litter EXIF), so no invalid value ever reaches
 * the insert.
 */
function toSqlDateTime(
  y: string,
  mo: string,
  d: string,
  h: string,
  mi: string,
  s: string,
): string | null {
  const year = Number(y);

  // Photography era: before this the value is EXIF junk, not a capture date.
  if (year < 1826 || year > 2100) {
    return null;
  }

  const dt = new Date(Date.UTC(year, Number(mo) - 1, Number(d), 0, 0, 0));

  if (dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    return null; // e.g. Feb 30
  }

  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    return null;
  }

  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** Capture date from the EXIF `DateTimeOriginal` in the JSON `img_metadata`. */
function extractCapturedAt(metadata: SqlValue): string | null {
  if (typeof metadata !== 'string') {
    return null;
  }

  const m = DATE_TIME_ORIGINAL_RE.exec(metadata);

  return m ? toSqlDateTime(m[1], m[2], m[3], m[4], m[5], m[6]) : null;
}

/** MediaWiki `img_timestamp` (binary(14) `YYYYMMDDHHMMSS`) → MySQL DATETIME. */
function parseUploadedAt(ts: SqlValue): string | null {
  if (typeof ts !== 'string') {
    return null;
  }

  const m = IMG_TIMESTAMP_RE.exec(ts);

  return m ? toSqlDateTime(m[1], m[2], m[3], m[4], m[5], m[6]) : null;
}

const GPS_IMG_DIRECTION_RE = /"GPSImgDirection":"(\d+)\/(\d+)"/;

/**
 * Camera azimuth (integer degrees, 0–359) from the EXIF `GPSImgDirection` in
 * the JSON `img_metadata` — a `num/den` rational. `GPSImgDirectionRef` (true vs
 * magnetic north) is ignored: it's almost always true north and the difference
 * is below the direction marker's resolution.
 */
function extractAzimuth(metadata: SqlValue): number | null {
  if (typeof metadata !== 'string') {
    return null;
  }

  const m = GPS_IMG_DIRECTION_RE.exec(metadata);

  if (!m) {
    return null;
  }

  const den = Number(m[2]);
  const deg = den === 0 ? NaN : Number(m[1]) / den;

  if (!Number.isFinite(deg)) {
    return null;
  }

  const r = Math.round(((deg % 360) + 360) % 360);

  return r === 360 ? 0 : r;
}

/**
 * `image` rows whose title is (probably) kept → `[title, capturedAt,
 * uploadedAt, authorId, azimuth]`. All from the row's EXIF/columns: capturedAt
 * from `DateTimeOriginal` and azimuth from `GPSImgDirection` (both in the JSON
 * `img_metadata`), uploadedAt from `img_timestamp`, authorId from the numeric
 * `img_actor` (the actor *name* isn't in any public Commons dump). `titleBits`
 * skips the ~99% of Commons files we don't keep; the authoritative filter is the
 * later SQL join on title.
 */
async function* imageMetaRows(
  titleBits: StringBitset,
): AsyncGenerator<SqlValue[]> {
  let idx: Record<string, number> | null = null;

  // img_timestamp is column index 11 (img_metadata, the big blob, is 4 and
  // can't be skipped since later columns follow it), so 12 fields cover it.
  for await (const { columns, values } of streamDumpRows(
    dumpStream(IMAGE_URL),
    'image',
    { maxFields: 12 },
  )) {
    if (!idx) {
      idx = columnIndex(columns);
    }

    const title = values[idx['img_name']];

    if (typeof title !== 'string' || !titleBits.has(title)) {
      continue;
    }

    const metadata = values[idx['img_metadata']];

    yield [
      title,
      extractCapturedAt(metadata),
      parseUploadedAt(values[idx['img_timestamp']]),
      values[idx['img_actor']] ?? null,
      extractAzimuth(metadata),
    ];
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

/**
 * Network errors on which re-streaming the whole dump pass is worth it: `got`
 * won't resume a stream once bytes have started, so a mid-download drop (a flaky
 * connection, or the machine sleeping) otherwise kills the entire import.
 */
const RETRYABLE_STREAM_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * Stream one dump pass into its (throwaway) staging table, retrying the whole
 * pass on a transient network drop. `makeSource` must build a FRESH generator
 * each attempt (a new download); the table is truncated between attempts so a
 * partial load is discarded. The bitset side effects of the sources are
 * idempotent (setting a bit twice is a no-op), so a retry re-derives the same
 * set. Non-network errors, and giving up after `attempts`, propagate.
 */
async function loadPass(
  table: string,
  insertSql: string,
  makeSource: () => AsyncIterable<SqlValue[]>,
  attempts = 4,
): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insertAll(makeSource(), insertSql);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;

      if (
        attempt >= attempts ||
        code === undefined ||
        !RETRYABLE_STREAM_CODES.has(code)
      ) {
        throw err;
      }

      logger.warn(
        `${table} pass failed (${code}, attempt ${attempt}/${attempts}); truncating and retrying…`,
      );

      await pool.query(sql`TRUNCATE TABLE ${raw(table)}`);

      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

export async function importWikimedia(): Promise<void> {
  const started = Date.now();

  await pool.query(sql`DROP TABLE IF EXISTS wm_stage`);
  await pool.query(sql`DROP TABLE IF EXISTS wm_keep`);
  await pool.query(sql`DROP TABLE IF EXISTS wm_img`);
  await pool.query(sql`DROP TABLE IF EXISTS wikimediaPicture_new`);

  // Heap staging table — no primary key so the (page-id-random) geo_tags rows
  // append sequentially instead of thrashing a clustered index.
  await pool.query(sql`CREATE TABLE wm_stage (
    pageId INT UNSIGNED NOT NULL,
    lat DOUBLE NOT NULL,
    lon DOUBLE NOT NULL
  ) ENGINE=InnoDB`);

  // Geotagged pageIds whose file is a real photo (page dump is page_id-ordered,
  // so this PK stays sequential). The title lets the metadata pass join back the
  // title-keyed `image` dump.
  await pool.query(sql`CREATE TABLE wm_keep (
    pageId INT UNSIGNED NOT NULL PRIMARY KEY,
    title VARBINARY(255) NOT NULL
  ) ENGINE=InnoDB`);

  // Per-title photo metadata from the image dump.
  await pool.query(sql`CREATE TABLE wm_img (
    title VARBINARY(255) NOT NULL,
    capturedAt DATETIME NULL,
    uploadedAt DATETIME NULL,
    authorId BIGINT UNSIGNED NULL,
    azimuth SMALLINT UNSIGNED NULL
  ) ENGINE=InnoDB`);

  // Bit-set of geotagged pageIds so the page pass only considers relevant rows.
  const seen = makeBitset();

  // Bit-set of kept titles so the image pass only stages the photos we keep.
  const titleBits = makeStringBitset();

  logger.info('Streaming geo_tags dump…');

  const geoCount = await loadPass(
    'wm_stage',
    'INSERT INTO wm_stage (pageId, lat, lon) VALUES (?, ?, ?)',
    () => geoTagRows(seen),
  );

  logger.info(
    `Loaded ${geoCount} camera geo tags. Streaming page dump for photo titles…`,
  );

  const keepCount = await loadPass(
    'wm_keep',
    'INSERT IGNORE INTO wm_keep (pageId, title) VALUES (?, ?)',
    () => pageKeepRows(seen, titleBits),
  );

  logger.info(
    `${keepCount} geotagged files are photos (of ${geoCount}). Streaming image dump for metadata…`,
  );

  const imgCount = await loadPass(
    'wm_img',
    'INSERT INTO wm_img (title, capturedAt, uploadedAt, authorId, azimuth) VALUES (?, ?, ?, ?, ?)',
    () => imageMetaRows(titleBits),
  );

  logger.info(`Staged metadata for ${imgCount} files. Building final table…`);

  // One sorted index build each — cheap versus maintaining them during the load.
  await pool.query(
    sql`ALTER TABLE wm_stage ADD INDEX wm_stage_pageId (pageId)`,
  );

  await pool.query(sql`ALTER TABLE wm_img ADD INDEX wm_img_title (title)`);

  // Final table: inner-join keeps only photo pageIds, the LEFT JOIN attaches
  // metadata (NULL when the image dump had no match), INSERT IGNORE dedups on
  // the pageId PK, ORDER BY pageId keeps that insert sequential. Spatial index
  // is added once afterwards.
  await pool.query(sql`CREATE TABLE wikimediaPicture_new (
    pageId INT UNSIGNED NOT NULL PRIMARY KEY,
    location POINT NOT NULL,
    capturedAt DATETIME NULL,
    uploadedAt DATETIME NULL,
    authorId BIGINT UNSIGNED NULL,
    azimuth SMALLINT UNSIGNED NULL
  ) ENGINE=InnoDB`);

  await pool.query(sql`INSERT IGNORE INTO wikimediaPicture_new
      (pageId, location, capturedAt, uploadedAt, authorId, azimuth)
    SELECT s.pageId, POINT(s.lon, s.lat),
      i.capturedAt, i.uploadedAt, i.authorId, i.azimuth
    FROM wm_stage s
    JOIN wm_keep k ON k.pageId = s.pageId
    LEFT JOIN wm_img i ON i.title = k.title
    ORDER BY s.pageId`);

  // Free the staging tables before the (temp-space-hungry) spatial index build —
  // keeps peak disk usage down on a nearly-full volume.
  await pool.query(sql`DROP TABLE wm_stage, wm_keep, wm_img`);

  logger.info('Building spatial index…');

  await pool.query(sql`ALTER TABLE wikimediaPicture_new
    ADD SPATIAL INDEX wikimediaPicture_location_spx (location)`);

  // Atomically swap the freshly built table in.
  await pool.query(sql`CREATE TABLE IF NOT EXISTS wikimediaPicture (
    pageId INT UNSIGNED NOT NULL PRIMARY KEY,
    location POINT NOT NULL,
    capturedAt DATETIME NULL,
    uploadedAt DATETIME NULL,
    authorId BIGINT UNSIGNED NULL,
    azimuth SMALLINT UNSIGNED NULL,
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
