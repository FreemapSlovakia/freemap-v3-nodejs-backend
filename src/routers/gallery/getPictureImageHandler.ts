import Router from '@koa/router';
import sql from 'sql-template-tag';
import sharp from 'sharp';
import { promises as fs, createReadStream } from 'fs';
import calculate from 'etag';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { picturesDir } from '../../routers/gallery/constants.js';

export function attachGetPictureImageHandler(router: Router) {
  router.get(
    '/pictures/:id/image',
    acceptValidator('image/jpeg'),
    async (ctx) => {
      const rows = await pool.query(
        sql`SELECT pathname FROM picture WHERE picture.id = ${ctx.params.id}`,
      );

      if (!rows.length) {
        ctx.throw(404, 'no such picture');
      }

      const pathname = `${picturesDir}/${rows[0].pathname}`;

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

      const w = parseInt(
        getFirst(ctx.headers.width) || getFirst(ctx.query.width) || 'NaN',
        10,
      );

      const resize = w ? sharp().resize(w).jpeg() : null;

      const fileStream = createReadStream(pathname);

      ctx.body = resize ? fileStream.pipe(resize) : fileStream;
    },
  );
}

function getFirst(x?: null | string[] | string): null | string {
  return Array.isArray(x) ? x[0] : x;
}
