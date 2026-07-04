import { createWriteStream } from 'node:fs';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RouterInstance } from '@koa/router';
import gdal from 'gdal-async';
import { ParameterizedContext } from 'koa';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  inBbox,
  type ParsedSource,
  parseElevationSources,
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
  ct: gdal.CoordinateTransformation | null;
};

// WGS84 built from proj4 to force traditional lon/lat axis order (GDAL 3 would
// otherwise use lat/lon for EPSG:4326).
const wgs84 = gdal.SpatialReference.fromProj4(
  '+proj=longlat +datum=WGS84 +no_defs',
);

type LocalSource = ParsedSource & {
  info?: DatasetInfo;
};

// Higher-precision, non-tiled sources, in priority order (first wins). A point
// is sampled from the first source whose bbox contains it and that returns real
// data; otherwise it falls back to the next source, then SRTM.
const localSources: LocalSource[] = parseElevationSources(
  getEnv('ELEVATION_SOURCES', ''),
);

// Local sources are opened lazily and kept open for the process lifetime.
function openLocalSource(src: LocalSource): DatasetInfo {
  if (src.info) {
    return src.info;
  }

  const dataset = gdal.open(src.path);

  const geoTransform = dataset.geoTransform;

  if (!geoTransform) {
    throw new Error(`Invalid geotransform for ${src.path}`);
  }

  src.info = {
    dataset,
    band: dataset.bands.get(1),
    geoTransform,
    width: dataset.rasterSize.x,
    height: dataset.rasterSize.y,
    // Build the target from proj4 rather than using dataset.srs directly: this
    // forces traditional easting/northing (x,y) axis order and drops the 3D
    // vertical of compound CRSs. Some CRSs (e.g. SWEREF99 TM / EPSG:5845)
    // declare northing-first axis order, which would otherwise make
    // transformPoint return swapped coordinates (gdal-async 3.12 has no
    // setAxisMappingStrategy to override it).
    ct: dataset.srs
      ? new gdal.CoordinateTransformation(
          wgs84,
          gdal.SpatialReference.fromProj4(dataset.srs.toProj4()),
        )
      : null,
  };

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
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ElevationResponseSchema } },
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
      requestBody: {
        content: { 'application/json': { schema: CoordsSchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ElevationResponseSchema } },
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

  const results: (number | null)[] = new Array(cs.length).fill(null);

  // High-precision local sources are a premium-only feature; everyone else gets
  // the global SRTM fallback.
  const premiumExpiration = ctx.state.user?.premiumExpiration;

  const sources =
    premiumExpiration && premiumExpiration > new Date() ? localSources : [];

  // Try the high-precision local sources first (priority order). Anything not
  // covered (outside every bbox, or only nodata there) falls back to SRTM.
  const srtmNeeded: number[] = [];

  for (let i = 0; i < cs.length; i++) {
    const [lat, lon] = cs[i];

    let resolved = false;

    for (const src of sources) {
      if (!inBbox(src.bbox, lat, lon)) {
        continue;
      }

      let v: number | null;

      try {
        v = await computeElevation(lat, lon, openLocalSource(src));
      } catch (err) {
        // a broken/unavailable local source (e.g. unmounted drive) must not
        // fail the request — fall back to the next source, then SRTM
        ctx.log.warn(
          { err, path: src.path },
          'elevation local source failed; falling back',
        );

        continue;
      }

      if (v != null) {
        results[i] = v;
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      srtmNeeded.push(i);
    }
  }

  if (srtmNeeded.length === 0 || !elevationDataDir) {
    ctx.response.body = ElevationResponseSchema.parse(results);

    return;
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
            ct: null,
          });
        }
      }),
    );

    for (const i of srtmNeeded) {
      const [lat, lon] = cs[i];

      const ds = dsMap.get(srtmKey(lat, lon));

      results[i] = ds ? await computeElevation(lat, lon, ds) : null;
    }

    ctx.response.body = ElevationResponseSchema.parse(results);
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
      throw new Error('Bad response: ' + res.status + ' ' + (await res.text()));
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
  { band, geoTransform, width, height, ct }: DatasetInfo,
) {
  const [gt0, gt1, gt2, gt3, gt4, gt5] = geoTransform;

  if (gt2 !== 0 || gt4 !== 0) {
    throw new Error('Rotated geotransforms are not supported');
  }

  // map lon/lat into the dataset CRS (identity for geographic SRTM)
  const { x, y } = ct ? ct.transformPoint(lon, lat) : { x: lon, y: lat };

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
