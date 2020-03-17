import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import sharp from 'sharp';
import { promises as fs, createReadStream } from 'fs';
import calculate from 'etag';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { PICTURES_DIR } from '../../routers/gallery/constants';

export function attachGetPictureImageHandler(router: Router) {
  router.get(
    '/pictures/:id/image',
    acceptValidator('image/jpeg'),
    async ctx => {
      const rows = await pool.query(
        SQL`SELECT pathname FROM picture WHERE picture.id = ${ctx.params.id}`,
      );

      if (!rows.length) {
        ctx.throw(404, 'no such picture');
      }

      const pathname = `${PICTURES_DIR}/${rows[0].pathname}`;

      let stats;

      try {
        stats = await fs.stat(pathname);
      } catch {
        ctx.throw(404, 'missing picture file');
      }

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

      const fileStream = createReadStream(pathname);

      ctx.body = resize ? fileStream.pipe(resize) : fileStream;
    },
  );
}
