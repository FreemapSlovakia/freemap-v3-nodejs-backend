import Router from '@koa/router';
import calculate from 'etag';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { picturesDir } from '../../routers/gallery/constants.js';

export function attachGetPictureImageHandler(router: Router) {
  router.get(
    '/pictures/:id/image',
    acceptValidator('image/jpeg'),
    authenticator(false),
    async (ctx) => {
      const [row] = await pool.query(
        sql`SELECT userId, pathname, premium FROM picture WHERE picture.id = ${ctx.params.id}`,
      );

      if (!row) {
        ctx.throw(404, 'no such picture');
      }

      if (
        row.premium &&
        !ctx.state.user?.isPremium &&
        ctx.state.user?.id !== row.userId
      ) {
        ctx.throw(402, 'only for premium users');
      }

      const pathname = `${picturesDir}/${row.pathname}`;

      let stats;

      try {
        stats = await stat(pathname);
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
        ctx.restatus = 304;

        return;
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
