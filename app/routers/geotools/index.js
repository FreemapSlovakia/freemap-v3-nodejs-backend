const Router = require('koa-router');
const fs = require('fs');
const utils = require('util');
const config = require('config');
const { spawn } = require('child_process');
const downloadGeoTiff = require('./downloader');

const hgtDir = config.get('elevation.dir');

const openAsync = utils.promisify(fs.open);
const closeAsync = utils.promisify(fs.close);
const readAsync = utils.promisify(fs.read);
const unlinkAsync = utils.promisify(fs.unlink);

const router = new Router();
const { acceptValidator } = require('~/requestValidators');

router.get('/elevation', compute);
router.post('/elevation', acceptValidator('application/json'), compute);

async function compute(ctx) {
  const { coordinates } = ctx.query;
  let cs;
  if (ctx.method === 'GET' && coordinates && /^([^,]+,[^,]+)(,[^,]+,[^,]+)*$/.test(coordinates)) {
    cs = coordinates
      .match(/[^,]+,[^,]+/g)
      .map(pair => pair.split(',').map(c => Number.parseFloat(c)));
  } else if (ctx.method === 'POST' && Array.isArray(ctx.request.body)) {
    cs = ctx.request.body;
  } else {
    ctx.status = 400;
    return;
  }

  if (!cs.every(x => Array.isArray(x) && x.length === 2 && x[0] >= -90 && x[0] <= 90 && x[1] >= -180 && x[1] <= 180)) {
    ctx.status = 400;
    return;
  }

  const fds = {};
  try {
    const items = await Promise.all(
      cs.map(async ([lat, lon]) => {
        const alat = Math.abs(lat);
        const alon = Math.abs(lon);
        const key = `${lat >= 0 ? 'N' : 'E'}${Math.floor(alat + (lat < 0 ? 1 : 0)).toString().padStart(2, '0')}`
          + `${lon >= 0 ? 'E' : 'W'}${Math.floor(alon + (lon < 0 ? 1 : 0)).toString().padStart(3, '0')}`;

        let fd = fds[key];

        if (fd === undefined) {
          const hgtPath = `${hgtDir}/${key}.HGT`;
          try {
            fd = await openAsync(hgtPath, 'r');
          } catch (e) {
            await fetchSafe(key);
            fd = await openAsync(hgtPath, 'r');
          }
          fds[key] = fd;
        }

        return [lat, lon, fd];
      }),
    );

    ctx.response.body = await Promise.all(items.map(computeElevation));
  } catch (e1) {
    await Promise.all(Object.values(fds).map(fd => closeAsync(fd)));
  }
}

module.exports = router;

// rename 's/n(..)_e(...)_1arc_v3.tif.HGT/N$1E$2.HGT/' *.HGT

const fetching = new Map();

async function fetchSafe(key) {
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

async function fetch(key) {
  const tifPath = `${hgtDir}/${key}.tif`;
  const hgtPath = `${hgtDir}/${key}.HGT`;
  try {
    await downloadGeoTiff(key, tifPath);

    await new Promise((resolve, reject) => {
      const child = spawn('gdal_translate', [tifPath, hgtPath]);
      child.on('exit', (code) => {
        if (code) {
          reject(new Error(`Nonzero exit code: ${code}`));
        } else {
          resolve();
        }
      });
      child.on('error', (err) => {
        reject(err);
      });
    });

    await unlinkAsync(tifPath);
  } catch (e) {
    await closeAsync(await openAsync(hgtPath, 'w+'));
  }
}

async function computeElevation([lat, lon, fd]) {
  const alat = Math.abs(lat);
  const alon = Math.abs(lon);

  const latFrac = alat - Math.floor(alat);
  const lonFrac = alon - Math.floor(alon);
  const y = (lat < 0 ? latFrac : (1 - latFrac)) * 3600;
  const x = (lon < 0 ? (1 - lonFrac) : lonFrac) * 3600;

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
    readAsync(fd, buffer, 0, 2, (y0 * 3601 + x0) * 2),
    readAsync(fd, buffer, 2, 2, (y1 * 3601 + x0) * 2),
    readAsync(fd, buffer, 4, 2, (y0 * 3601 + x1) * 2),
    readAsync(fd, buffer, 6, 2, (y1 * 3601 + x1) * 2),
  ]);

  const v00 = buffer.readInt16BE(0);
  const v01 = buffer.readInt16BE(2);
  const v10 = buffer.readInt16BE(4);
  const v11 = buffer.readInt16BE(6);

  return (0
    + v00 * wx0 * wy0
    + v01 * wx0 * wy1
    + v10 * wx1 * wy0
    + v11 * wx1 * wy1
  ) / (wx0 * wy0 + wx0 * wy1 + wx1 * wy0 + wx1 * wy1);
}
