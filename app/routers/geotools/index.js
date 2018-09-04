const Router = require('koa-router');
const fs = require('fs');
const utils = require('util');
const config = require('config');

const hgtDir = config.get('dir.hgt');

const openAsync = utils.promisify(fs.open);
const readAsync = utils.promisify(fs.read);

const router = new Router();

// /elevation?coordinates=lat1,lon1,lat2,lon2
router.get('/elevation', async (ctx) => {
  const { coordinates } = ctx.query;
  if (coordinates) {
    ctx.response.body = await Promise.all(
      coordinates
        .match(/[^,]+,[^,]+/g)
        .map(pair => pair.split(',').map(c => Number.parseFloat(c)))
        .map(async ([lat, lon]) => {
          const alat = Math.abs(lat);
          const alon = Math.abs(lon);
          const path = `${hgtDir}/${lat >= 0 ? 'N' : 'E'}${Math.floor(alat).toString().padStart(2, '0')}`
            + `${lon >= 0 ? 'E' : 'W'}${Math.floor(alon).toString().padStart(3, '0')}.HGT`;
          const fd = await openAsync(path, 'r');
          const latFrac = alat - Math.floor(alat);
          const lonFrac = alon - Math.floor(alon);
          const y = (1 - latFrac) * 3600;
          const x = lonFrac * 3600;

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
        }),
    );
  }
});

module.exports = router;

// rename 's/n(..)_e(...)_1arc_v3.tif.HGT/N$1E$2.HGT/' *.HGT
