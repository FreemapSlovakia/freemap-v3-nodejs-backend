const Router = require('koa-router');
const fs = require('fs');
const utils = require('util');

const openAsync = utils.promisify(fs.open);
const readAsync = utils.promisify(fs.read);

const router = new Router();

// lat1,lon1,lat2,lon2
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
          const path = `/home/martin/hgt/${lat >= 0 ? 'N' : 'E'}${Math.round(alat).toString().padStart(2, '0')}`
            + `${lon >= 0 ? 'E' : 'W'}${Math.round(alon).toString().padStart(3, '0')}`;
          const fd = await openAsync(path);
          const buffer = Buffer.alloc(2);
          await readAsync(fd, buffer, 0, 2, Math.round((1 - (alat - Math.round(alat))) * 3600) * 3601 + (alon - Math.round(alon)) * 3600);
          return buffer.readInt16BE();
        }),
    );
  }
});

module.exports = router;
