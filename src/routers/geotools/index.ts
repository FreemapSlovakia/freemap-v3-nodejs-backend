import Router from '@koa/router';
import got from 'got';
import { ParameterizedContext } from 'koa';
import { createWriteStream, fstat, read, WriteStream } from 'node:fs';
import { FileHandle, open, rename, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import unzipper from 'unzipper';
import { getEnv } from '../../env.js';
import { acceptValidator } from '../../requestValidators.js';

const hgtDir = getEnv('ELEVATION_DATA_DIRECTORY');

const router = new Router();

const fstatAsync = promisify(fstat);

const readAsync = promisify(read);

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
    cs = ctx.request.body;
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

  const fdMap = new Map<string, [FileHandle, number]>();

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

          const hgtPath = `${hgtDir}/${key}.HGT`;

          let fd;

          try {
            fd = await open(hgtPath, 'r');
          } catch (e) {
            try {
              await fetchSafe(key);

              fd = await open(hgtPath, 'r');
            } catch (e) {
              await (await open(hgtPath, 'w')).close();

              fd = await open(hgtPath, 'r');
            }
          }

          fdMap.set(key, [fd, (await fstatAsync(fd.fd)).size]);
        }

        return [lat, lon, key] as const;
      }),
    );

    type Tuple = [number, number, FileHandle, number];

    const mmm = items
      .map((item) => {
        const f = fdMap.get(item[2]);

        return f && ([item[0], item[1], f[0], f[1]] as Tuple);
      })
      .filter((a): a is Tuple => Boolean(a));

    ctx.response.body = await Promise.all(mmm.map(computeElevation));
  } finally {
    await Promise.all([...fdMap.values()].map(([fd]) => fd.close()));
  }
}

export const geotoolsRouter = router;

const fetching = new Map<string, Promise<void>>();

async function fetchSafe(key: string) {
  let promise = fetching.get(key);

  if (promise) {
    return promise;
  }

  promise = fetch(key);

  fetching.set(key, promise);

  const val = await promise;

  fetching.delete(key);

  return val;
}

async function fetch(key: string) {
  const fname = `${hgtDir}/${key}.HGT`;

  const temp = `${fname}.tmp`;

  let ws;

  try {
    await new Promise<void>((resolve, reject) => {
      ws = createWriteStream(temp);

      ws.on('finish', () => resolve());

      ws.on('error', (e) => reject(e));

      const unzipOne = unzipper.ParseOne();

      unzipOne.on('error', (e) => reject(e));

      got.stream
        .get(
          `https://e4ftl01.cr.usgs.gov/MEASURES/SRTMGL1.003/2000.02.11/${key}.SRTMGL1.hgt.zip`,
          {
            hooks: {
              beforeRedirect: [
                (options, response) => {
                  if (
                    typeof options.url === 'string'
                      ? options.url
                      : options.url?.href.startsWith(
                          'https://urs.earthdata.nasa.gov/oauth/authorize',
                        )
                  ) {
                    options.headers.authorization = `Basic ${Buffer.from(
                      getEnv('URS_EARTHDATA_NASA_USERNAME') +
                        ':' +
                        getEnv('URS_EARTHDATA_NASA_PASSWORD'),
                    ).toString('base64')}`;
                  }

                  const c = response.headers['set-cookie'];

                  const m = c && /^(DATA=.*?);/.exec(c[0]);

                  if (m && m[1]) {
                    options.headers.cookie = m[1];
                  }
                },
              ],
            },
          },
        )
        .on('error', (e) => reject(e))
        .pipe(unzipOne)
        .pipe(ws);
    });

    await rename(temp, fname);
  } finally {
    if (ws) {
      (ws as WriteStream).close();
      await unlink(temp).catch(() => {});
    }
  }
}

async function computeElevation([lat, lon, fd, size]: [
  number,
  number,
  FileHandle,
  number,
]) {
  // gdal_translate supports: 1201x1201, 3601x3601 or 1801x3601
  const rx =
    size === 1801 * 3601 * 2 ? 1800 : size === 1201 * 1201 * 2 ? 1200 : 3600;
  const ry = size === 1201 * 1201 * 2 ? 1200 : 3600;

  const alat = Math.abs(lat);
  const alon = Math.abs(lon);

  const latFrac = alat - Math.floor(alat);
  const lonFrac = alon - Math.floor(alon);
  const y = (lat < 0 ? latFrac : 1 - latFrac) * ry;
  const x = (lon < 0 ? 1 - lonFrac : lonFrac) * rx;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const wx0 = 1 - (x - x0);
  const wy0 = 1 - (y - y0);
  const x1 = Math.ceil(x);
  const y1 = Math.ceil(y);
  const wx1 = 1 - (x1 - x);
  const wy1 = 1 - (y1 - y);

  const buffer = Buffer.alloc(8);
  await Promise.all([
    readAsync(fd.fd, buffer, 0, 2, (y0 * (rx + 1) + x0) * 2),
    readAsync(fd.fd, buffer, 2, 2, (y1 * (rx + 1) + x0) * 2),
    readAsync(fd.fd, buffer, 4, 2, (y0 * (rx + 1) + x1) * 2),
    readAsync(fd.fd, buffer, 6, 2, (y1 * (rx + 1) + x1) * 2),
  ]);

  const v00 = buffer.readInt16BE(0);
  const v01 = buffer.readInt16BE(2);
  const v10 = buffer.readInt16BE(4);
  const v11 = buffer.readInt16BE(6);

  return (
    (0 +
      v00 * wx0 * wy0 +
      v01 * wx0 * wy1 +
      v10 * wx1 * wy0 +
      v11 * wx1 * wy1) /
    (wx0 * wy0 + wx0 * wy1 + wx1 * wy0 + wx1 * wy1)
  );
}
