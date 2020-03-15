const SQL = require('sql-template-strings');
const sharp = require('sharp');
const fs = require('fs');
const { promisify } = require('util');
const calculate = require('etag');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const { PICTURES_DIR } = require('~/routers/gallery/constants');

const statSync = promisify(fs.stat);

module.exports = function attachGetPictureHandler(router) {
  router.get(
    '/pictures/:id/image',
    acceptValidator('image/jpeg'),
    async ctx => {
      const rows = await pool.query(
        SQL`SELECT pathname FROM picture WHERE picture.id = ${ctx.params.id}`,
      );

      if (!rows.length) {
        ctx.throw(404);
      }

      const pathname = `${PICTURES_DIR}/${rows[0].pathname}`;

      const stats = await statSync(pathname);

      ctx.status = 200;

      ctx.response.lastModified = stats.mtime;

      ctx.append('Vary', 'Width');

      ctx.response.etag = calculate(stats, {
        weak: true,
      });

      ctx.type = 'image/jpeg';

      if (ctx.fresh) {
        ctx.throw(304);
      }

      const w = parseInt(ctx.headers.width || ctx.query.width || 'NaN', 10);

      const resize = w
        ? sharp()
            .resize(w)
            .jpeg()
        : null;

      const fileStream = fs.createReadStream(pathname);

      ctx.body = resize ? fileStream.pipe(resize) : fileStream;
    },
  );
};
