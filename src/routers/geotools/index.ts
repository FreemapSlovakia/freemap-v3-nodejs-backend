import Router from '@koa/router';
import { ParameterizedContext } from 'koa';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { getEnv } from '../../env.js';
import { acceptValidator } from '../../requestValidators.js';
import { inCountries } from './inCountries.js';
import { assert } from 'typia';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import gdal from 'gdal-async';

const elevationDataDir = getEnv('ELEVATION_DATA_DIRECTORY');

const router = new Router();

type DatasetInfo = {
  dataset: gdal.Dataset;
  band: gdal.RasterBand;
  geoTransform: number[];
  width: number;
  height: number;
};

router.post('/in-count', inCountries);

router.get('/elevation', compute);

router.post('/elevation', acceptValidator('application/json'), compute);

async function compute(ctx: ParameterizedContext) {
  const coordinates = Array.isArray(ctx.query.coordinates)
    ? ctx.query.coordinates.join(',')
    : ctx.query.coordinates;

  let cs: number[][] | undefined;

  if (
    ctx.method === 'GET' &&
    coordinates &&
    /^([^,]+,[^,]+)(,[^,]+,[^,]+)*$/.test(coordinates)
  ) {
    cs = coordinates
      .match(/[^,]+,[^,]+/g)
      ?.map((pair) => pair.split(',').map((c) => Number.parseFloat(c)));
  } else if (ctx.method === 'POST' && Array.isArray(ctx.request.body)) {
    try {
      cs = assert<number[][]>(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }
  } else {
    ctx.throw(400, 'invalid request parameters');
  }

  if (
    !cs?.every(
      (x) =>
        Array.isArray(x) &&
        x.length === 2 &&
        x[0] >= -90 &&
        x[0] <= 90 &&
        x[1] >= -180 &&
        x[1] <= 180,
    )
  ) {
    ctx.throw(400, 'coordinate not in valid range');
  }

  const allocated = new Set<string>();

  const dsMap = new Map<string, DatasetInfo>();

  try {
    const items = await Promise.all(
      cs.map(async ([lat, lon]) => {
        const alat = Math.abs(lat);

        const alon = Math.abs(lon);

        const key =
          `${lat >= 0 ? 'N' : 'E'}${Math.floor(alat + (lat < 0 ? 1 : 0))
            .toString()
            .padStart(2, '0')}` +
          `${lon >= 0 ? 'E' : 'W'}${Math.floor(alon + (lon < 0 ? 1 : 0))
            .toString()
            .padStart(3, '0')}`;

        if (!allocated.has(key)) {
          allocated.add(key);

          const tifPath = `${elevationDataDir}/${key}.tif`;

          let dataset: gdal.Dataset | undefined;

          try {
            dataset = gdal.open(tifPath);
          } catch {
            await downloadDataSafeSafe(key);
            dataset = gdal.open(tifPath);
          }

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
          });
        }

        return [lat, lon, key] as const;
      }),
    );

    type Tuple = [number, number, DatasetInfo];

    const params = items
      .map((item) => {
        const ds = dsMap.get(item[2]);

        return ds && ([item[0], item[1], ds] as Tuple);
      })
      .filter((a): a is Tuple => Boolean(a));

    ctx.response.body = await Promise.all(params.map(computeElevation));
  } finally {
    for (const { dataset } of dsMap.values()) {
      dataset.close();
    }
  }
}

export const geotoolsRouter = router;

const fetching = new Map<string, Promise<void>>();

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

    if (!res.ok || !res.body) {
      throw new Error('Bad response.');
    }

    await pipeline(Readable.fromWeb(res.body), createWriteStream(tempTif));

    await rename(tempTif, fname);
  } finally {
    await unlink(tempTif).catch(() => {});
  }
}

async function computeElevation([
  lat,
  lon,
  { band, geoTransform, width, height },
]: [number, number, DatasetInfo]) {
  const [gt0, gt1, gt2, gt3, gt4, gt5] = geoTransform;

  if (gt2 !== 0 || gt4 !== 0) {
    throw new Error('Rotated geotransforms are not supported');
  }

  const px = (lon - gt0) / gt1;
  const py = (lat - gt3) / gt5;

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) {
    return null;
  }

  const dx = px - x0;
  const dy = py - y0;
  const wx0 = 1 - dx;
  const wy0 = 1 - dy;
  const wx1 = dx;
  const wy1 = dy;

  const nodata = band.noDataValue;

  const sample = (x: number, y: number) => {
    const val = band.pixels.get(x, y);

    return nodata !== null && nodata !== undefined && val === nodata
      ? null
      : val;
  };

  const v00 = sample(x0, y0);
  const v01 = sample(x0, y1);
  const v10 = sample(x1, y0);
  const v11 = sample(x1, y1);

  const weighted = [
    [v00, wx0 * wy0],
    [v01, wx0 * wy1],
    [v10, wx1 * wy0],
    [v11, wx1 * wy1],
  ].filter((entry): entry is [number, number] => entry[0] !== null);

  return weighted.length
    ? weighted.reduce((acc, [v, w]) => acc + v * w, 0) /
        weighted.reduce((acc, [, w]) => acc + w, 0)
    : null;
}
