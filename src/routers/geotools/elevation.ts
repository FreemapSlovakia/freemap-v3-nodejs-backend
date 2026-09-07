import { createWriteStream } from 'node:fs';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RouterInstance } from '@koa/router';
import gdal from 'gdal-async';
import type { ParameterizedContext } from 'koa';
import type { Logger } from 'pino';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  type Bbox,
  createInverseProjector,
  createProjector,
  datasetBbox,
  inBbox,
  loadElevationSources,
  mergeCredits,
  type ParsedSource,
  type Projector,
  type SourceAttribution,
  SRTM_SOURCE_NAME,
  srtmKey,
} from './elevationHelpers.js';

// Optional: when unset, the global SRTM fallback is disabled and points not
// covered by a local source return null.
const elevationDataDir = getEnv('ELEVATION_DATA_DIRECTORY', '');

// Reading the SRS of some GeoTIFFs (e.g. EPSG:8353 / S-JTSK [JTSK03]) throws
// unless we tell GDAL to trust the EPSG registry over the embedded GeoTIFF keys.
gdal.config.set('GTIFF_SRS_SOURCE', 'EPSG');

const fetching = new Map<string, Promise<void>>();

type DatasetInfo = {
  dataset: gdal.Dataset;
  band: gdal.RasterBand;
  geoTransform: number[];
  width: number;
  height: number;
  // transform from WGS84 lon/lat into the dataset CRS; null when the dataset is
  // already geographic lon/lat (SRTM).
  project: Projector | null;
};

// A local source additionally knows its WGS84 footprint, which is what decides
// whether it is asked about a point at all. SRTM tiles carry none: they are
// addressed by tile key, so they are never bbox-tested.
type LocalDatasetInfo = DatasetInfo & {
  // from `source.json` when it pins one, else derived on open
  bbox: Bbox;
};

type LocalSource = ParsedSource & {
  info?: LocalDatasetInfo;
  // Set once opening has failed, so a source on an unmounted drive is tried
  // once rather than once per coordinate — a request carries an unbounded list
  // of them, and each retry is a synchronous gdal.open plus a log line.
  broken?: boolean;
};

// Higher-precision, non-tiled sources, in priority order (first wins). A point
// is sampled from the first source whose bbox contains it and that returns real
// data; otherwise it falls back to the next source, then SRTM.
//
// Each lives in its own directory under ELEVATION_DIR with a `source.json`
// carrying its reported name and its credits, so adding a model is a directory
// drop: no config to edit, no bbox to transcribe, and — because the API serves
// the credits — no client release to make them visible.
const elevationDir = getEnv('ELEVATION_DIR', '');

const localSources: LocalSource[] = loadElevationSources(
  elevationDir,
  // console rather than the request logger: this runs while the module is
  // still being evaluated, before any logger exists
  (message, err) => console.warn(message, err),
);

// ELEVATION_SOURCES was the previous config and is no longer read. Left set on
// its own it would degrade every premium read to SRTM in silence, so say so
// rather than let the high-precision models quietly disappear.
if (!elevationDir && getEnv('ELEVATION_SOURCES', '')) {
  console.warn(
    'ELEVATION_SOURCES is set but ELEVATION_DIR is not: it has been replaced ' +
      'by one directory per source (see README). No local elevation sources ' +
      'are loaded, so every read falls back to SRTM.',
  );
}

// SRTM has no source directory — the code owns the tile scheme and the download
// URL, so it owns the credit too.
const SRTM_ATTRIBUTION: SourceAttribution[] = [
  { name: 'SRTM', url: 'https://www.earthdata.nasa.gov/data/instruments/srtm' },
];

/**
 * Local sources are opened lazily and kept open for the process lifetime, and
 * their footprint is derived on that first open rather than at startup, so boot
 * doesn't wait on 30-odd rasters.
 *
 * The cost is moved rather than removed: since the bbox is what the open
 * produces, the priority loop has to open a source to find out whether it even
 * covers the point, so the first request for somewhere no local source holds
 * walks the whole list. That is one open and one derivation per source, once per
 * process. Pin `bbox` in `source.json` for a source where even that is too much
 * — the derivation is then skipped and only the read itself is deferred.
 */
function openLocalSource(src: LocalSource): LocalDatasetInfo {
  if (src.info) {
    return src.info;
  }

  if (src.broken) {
    throw new Error(`Elevation source ${src.path} failed to open earlier`);
  }

  src.broken = true; // cleared once the open has actually succeeded

  const dataset = gdal.open(src.path);

  const geoTransform = dataset.geoTransform;

  if (!geoTransform) {
    throw new Error(`Invalid geotransform for ${src.path}`);
  }

  const width = dataset.rasterSize.x;

  const height = dataset.rasterSize.y;

  src.info = {
    dataset,
    band: dataset.bands.get(1),
    geoTransform,
    width,
    height,
    project: createProjector(dataset.srs),
    bbox:
      src.bbox ??
      datasetBbox(
        geoTransform,
        width,
        height,
        createInverseProjector(dataset.srs),
      ),
  };

  src.broken = false;

  return src.info;
}

const CoordSchema = z.tuple([
  z.number().min(-90).max(90).meta({ description: 'latitude' }),
  z.number().min(-180).max(180).meta({ description: 'longitude' }),
]);

const CoordsSchema = z.union([CoordSchema, CoordSchema.array()]);

const CoordSchemaC = z
  .string()
  .transform((s) => s.split(',').map(Number))
  .pipe(CoordSchema);

const CoordsSchemaC = z.union([CoordSchemaC, CoordSchemaC.array()]);

const ElevationResponseSchema = z.array(
  z
    .number()
    .nullable()
    .meta({ description: 'elevation in meters above sea level' }),
);

const AttributionSchema = z.object({
  name: z.string().meta({
    description: 'the credit line, verbatim as the licence asks for it',
  }),
  url: z
    .string()
    .optional()
    .meta({ description: 'where the dataset lives, when there is a page' }),
});

// Returned instead of the bare array when `sources=1` is in the query string.
const ElevationWithSourcesResponseSchema = z.object({
  elevations: ElevationResponseSchema,
  sources: z.array(z.string()).meta({
    description:
      'names of the elevation datasets that answered, deduplicated; ' +
      'local sources first, then the global fallback. The order carries no ' +
      'meaning beyond that — do not rely on it',
  }),
  attributions: z.array(AttributionSchema).meta({
    description:
      'every credit to display for the datasets that answered, deduplicated. ' +
      'Show these rather than mapping `sources` yourself, so a dataset added ' +
      'server-side needs no client release. NOT parallel to `sources`: one ' +
      'name may carry several credits (a country stitched from two licensed ' +
      'datasets) or none, so do not pair them up by index',
  }),
});

const SourcesSchema = z
  .literal('1')
  .optional()
  .meta({ description: 'set to 1 to also report the datasets used' });

export function attachElevationHandler(router: RouterInstance) {
  registerPath('/geotools/elevation', {
    get: {
      summary: 'Get elevation for coordinates (query params)',
      description:
        'Premium users get higher-precision data where available; ' +
        'others get the global fallback dataset.',
      tags: ['geotools'],
      security: AUTH_OPTIONAL,
      requestParams: {
        query: z.object({
          coordinates: CoordsSchemaC,
          sources: SourcesSchema,
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.union([
                ElevationResponseSchema,
                ElevationWithSourcesResponseSchema,
              ]),
            },
          },
        },
      },
    },
    post: {
      summary: 'Get elevation for a list of coordinates',
      description:
        'Premium users get higher-precision data where available; ' +
        'others get the global fallback dataset.',
      tags: ['geotools'],
      security: AUTH_OPTIONAL,
      requestParams: {
        query: z.object({
          sources: SourcesSchema,
        }),
      },
      requestBody: {
        content: { 'application/json': { schema: CoordsSchema } },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.union([
                ElevationResponseSchema,
                ElevationWithSourcesResponseSchema,
              ]),
            },
          },
        },
        400: {},
      },
    },
  });

  router.get('/elevation', authenticator(false), compute);

  router.post(
    '/elevation',
    acceptValidator('application/json'),
    authenticator(false),
    compute,
  );
}

async function compute(ctx: ParameterizedContext) {
  let cs: [number, number][];

  try {
    const a =
      ctx.method === 'POST'
        ? CoordsSchema.parse(ctx.request.body)
        : CoordsSchemaC.parse(ctx.query.coordinates);

    cs = (Array.isArray(a[0]) ? a : [a]) as [number, number][];
  } catch (err) {
    return ctx.throw(400, err as Error);
  }

  // High-precision local sources are a premium-only feature; everyone else gets
  // the global SRTM fallback.
  const premiumExpiration = ctx.state.user?.premiumExpiration;

  const premium = Boolean(premiumExpiration && premiumExpiration > new Date());

  const usedSources =
    ctx.query.sources === '1'
      ? new Map<string, SourceAttribution[]>()
      : undefined;

  const elevations = await resolveElevations(cs, premium, ctx.log, usedSources);

  ctx.response.body = usedSources
    ? ElevationWithSourcesResponseSchema.parse({
        elevations,
        sources: [...usedSources.keys()],
        attributions: [...usedSources.values()].flat(),
      })
    : ElevationResponseSchema.parse(elevations);
}

/**
 * Resolve the elevation (metres a.s.l.) for each `[lat, lon]` coordinate, or
 * `null` where no source covers the point. Premium callers get the
 * high-precision local sources first (priority order), with the global SRTM
 * dataset as the fallback for everyone.
 *
 * When `usedSources` is given, every source that actually yielded a value is
 * added to it, mapped to how it wants to be credited. The local sources are all
 * resolved before the SRTM fallback pass runs, so SRTM always lands last
 * regardless of which point it answered first — the map is a membership report,
 * not an ordering.
 */
export async function resolveElevations(
  cs: [number, number][],
  premium: boolean,
  log: Pick<Logger, 'warn'>,
  usedSources?: Map<string, SourceAttribution[]>,
): Promise<(number | null)[]> {
  const results: (number | null)[] = new Array(cs.length).fill(null);

  const sources = premium ? localSources : [];

  // Try the high-precision local sources first (priority order). Anything not
  // covered (outside every bbox, or only nodata there) falls back to SRTM.
  const srtmNeeded: number[] = [];

  for (let i = 0; i < cs.length; i++) {
    const [lat, lon] = cs[i];

    let resolved = false;

    for (const src of sources) {
      let v: number | null;

      try {
        // opening also settles the footprint, so the bbox test comes after it;
        // the open is cached, making this a plain comparison from then on
        const info = openLocalSource(src);

        if (!inBbox(info.bbox, lat, lon)) {
          continue;
        }

        v = await computeElevation(lat, lon, info);
      } catch (err) {
        // a broken/unavailable local source (e.g. unmounted drive) must not
        // fail the request — fall back to the next source, then SRTM
        log.warn(
          { err, path: src.path },
          'elevation local source failed; falling back',
        );

        continue;
      }

      if (v != null) {
        results[i] = v;
        resolved = true;
        if (usedSources) {
          // One name can be answered by several rasters — every Sonny country
          // reports `sonny` — so merge rather than overwrite, or whichever
          // answered last would be the only one credited.
          mergeCredits(usedSources, src.name, src.attributions);
        }

        break;
      }
    }

    if (!resolved) {
      srtmNeeded.push(i);
    }
  }

  if (srtmNeeded.length === 0 || !elevationDataDir) {
    return results;
  }

  const allocated = new Set<string>();

  const dsMap = new Map<string, DatasetInfo>();

  try {
    await Promise.all(
      srtmNeeded.map(async (i) => {
        const [lat, lon] = cs[i];

        const key = srtmKey(lat, lon);

        if (allocated.has(key)) {
          return;
        }

        allocated.add(key);

        const tifPath = `${elevationDataDir}/${key}.tif`;

        let dataset: gdal.Dataset | undefined;

        try {
          dataset = gdal.open(tifPath);
        } catch {
          await downloadDataSafeSafe(key);

          try {
            dataset = gdal.open(tifPath);
          } catch (err) {
            const s = await stat(tifPath).catch(() => undefined);

            if (!s || s.size > 0) {
              throw err;
            }
          }
        }

        if (dataset) {
          const geoTransform = dataset.geoTransform;

          if (!geoTransform) {
            throw new Error(`Invalid geotransform for ${key}`);
          }

          dsMap.set(key, {
            dataset,
            band: dataset.bands.get(1),
            geoTransform,
            width: dataset.rasterSize.x,
            height: dataset.rasterSize.y,
            project: null,
          });
        }
      }),
    );

    for (const i of srtmNeeded) {
      const [lat, lon] = cs[i];

      const ds = dsMap.get(srtmKey(lat, lon));

      results[i] = ds ? await computeElevation(lat, lon, ds) : null;

      if (results[i] != null && usedSources) {
        mergeCredits(usedSources, SRTM_SOURCE_NAME, SRTM_ATTRIBUTION);
      }
    }

    return results;
  } finally {
    for (const { dataset } of dsMap.values()) {
      dataset?.close();
    }
  }
}

async function downloadDataSafeSafe(key: string) {
  let promise = fetching.get(key);

  if (promise) {
    return promise;
  }

  promise = downloadData(key);

  fetching.set(key, promise);

  const val = await promise;

  fetching.delete(key);

  return val;
}

async function downloadData(key: string) {
  const fname = `${elevationDataDir}/${key}.tif`;

  const tempTif = `${fname}.tmp`;

  try {
    const res = await fetch(
      `https://opentopography.s3.sdsc.edu/raster/SRTM_GL1/SRTM_GL1_srtm/${key}.tif`,
    );

    if (res.status === 404) {
      await writeFile(fname, '');
      return;
    }

    if (!res.ok || !res.body) {
      throw new Error(`Bad response: ${res.status} ${await res.text()}`);
    }

    await pipeline(Readable.fromWeb(res.body), createWriteStream(tempTif));

    await rename(tempTif, fname);
  } finally {
    await unlink(tempTif).catch(() => undefined);
  }
}

async function computeElevation(
  lat: number,
  lon: number,
  { band, geoTransform, width, height, project }: DatasetInfo,
) {
  const [gt0, gt1, gt2, gt3, gt4, gt5] = geoTransform;

  if (gt2 !== 0 || gt4 !== 0) {
    throw new Error('Rotated geotransforms are not supported');
  }

  // map lon/lat into the dataset CRS (identity for geographic SRTM)
  const { x, y } = project ? project(lon, lat) : { x: lon, y: lat };

  const px = (x - gt0) / gt1;
  const py = (y - gt3) / gt5;

  // a point outside the projection's valid domain can transform to a non-finite
  // value, which would slip past the bounds check below (NaN comparisons are
  // all false) and corrupt the pixel read
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return null;
  }

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);

  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) {
    return null;
  }

  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  // Read the 2x2 (or smaller, at the raster edge) neighbourhood in a single
  // async call so the disk I/O runs on GDAL's thread pool instead of blocking
  // the event loop.
  const cols = x1 > x0 ? 2 : 1;
  const rows = y1 > y0 ? 2 : 1;

  const data = await band.pixels.readAsync(x0, y0, cols, rows);

  const ix1 = cols - 1; // column offset of x1 within the window (0 or 1)
  const iy1 = rows - 1; // row offset of y1 within the window (0 or 1)

  const nodata = band.noDataValue;

  const norm = (val: number) => (nodata != null && val === nodata ? null : val);

  const v00 = norm(data[0]);
  const v10 = norm(data[ix1]);
  const v01 = norm(data[iy1 * cols]);
  const v11 = norm(data[iy1 * cols + ix1]);

  const dx = px - x0;
  const dy = py - y0;

  const weighted = [
    [v00, (1 - dx) * (1 - dy)],
    [v01, (1 - dx) * dy],
    [v10, dx * (1 - dy)],
    [v11, dx * dy],
  ].filter((entry): entry is [number, number] => entry[0] !== null);

  return weighted.length
    ? weighted.reduce((acc, [v, w]) => acc + v * w, 0) /
        weighted.reduce((acc, [, w]) => acc + w, 0)
    : null;
}
