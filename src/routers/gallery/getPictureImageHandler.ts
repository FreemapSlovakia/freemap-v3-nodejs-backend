import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { RouterInstance } from '@koa/router';
import calculate from 'etag';
import sharp from 'sharp';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { picturesDir } from '../../routers/gallery/constants.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

export function attachGetPictureImageHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}/image', {
    get: {
      summary: 'Get the image file for a gallery picture',
      tags: ['gallery'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: {
          content: {
            'image/jpeg': {},
          },
        },
        401: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.get(
    '/pictures/:id/image',
    acceptValidator('image/jpeg'),
    authenticator(false),
    async (ctx) => {
      const [row] = await pool.query<
        {
          userId: number;
          pathname: string;
          premium: boolean;
        }[]
      >(
        sql`SELECT userId, pathname, premium FROM picture WHERE picture.id = ${ctx.params.id}`,
      );

      if (!row) {
        ctx.throw(404, 'no such picture');
      }

      if (
        row.premium &&
        (!ctx.state.user?.premiumExpiration ||
          ctx.state.user.premiumExpiration < new Date()) &&
        ctx.state.user?.id !== row.userId
      ) {
        if (secret && typeof ctx.request.query.hmac === 'string') {
          if (
            createHmac('sha256', secret).update(ctx.params.id).digest('hex') !==
            ctx.request.query.hmac
          ) {
            return ctx.throw(403, 'invalid hmac');
          }
        } else {
          return ctx.throw(402, 'only for premium users');
        }
      }

      const pathname = `${picturesDir}/${row.pathname}`;

      let stats;

      try {
        stats = await stat(pathname);
      } catch {
        return ctx.throw(404, 'missing picture file');
      }

      ctx.status = 200;

      ctx.response.lastModified = stats.mtime;

      ctx.append('Vary', 'Width');

      ctx.type = 'image/jpeg';

      const requested = parseInt(
        getFirst(ctx.headers.width) || getFirst(ctx.query.width) || 'NaN',
        10,
      );

      // Clamp the requested width to the picture's own width. Upscaling costs
      // CPU and bandwidth for no added detail, and an unbounded value is a cheap
      // amplification attack: ?width=60000 on a 3776px photo takes over a minute
      // to encode and yields an 83 MiB response. A request at or above native
      // size (common on hi-DPI screens in fullscreen) serves the file untouched,
      // which also avoids a pointless re-compression of an already lossy JPEG.
      let width = 0;

      if (requested > 0) {
        try {
          const meta = await sharp(pathname).metadata();

          // EXIF orientations 5-8 rotate by 90°, so the width the client sees
          // is the stored height.
          const nativeWidth =
            ((meta.orientation ?? 1) >= 5 ? meta.height : meta.width) ?? 0;

          if (requested < nativeWidth) {
            width = requested;
          }
        } catch {
          // unreadable header - fall through and serve the file untouched
        }
      }

      // The width is part of what the body is, so it has to be part of the
      // validator too. Keying only on the file's stats made every width share
      // one ETag, letting a cache answer a full-size request with a thumbnail.
      ctx.response.etag = calculate(`${stats.size}-${stats.mtimeMs}-${width}`, {
        weak: true,
      });

      if (ctx.fresh) {
        ctx.status = 304;

        return;
      }

      const fileStream = createReadStream(pathname);

      // rotate() applies the EXIF orientation up front, because sharp drops the
      // tag when re-encoding - without it a resized photo that relies on the tag
      // comes out sideways while the unresized URL renders upright.
      ctx.body = width
        ? fileStream.pipe(sharp().rotate().resize(width).jpeg())
        : fileStream;
    },
  );
}

function getFirst(x?: undefined | string[] | string): undefined | string {
  return Array.isArray(x) ? x[0] : x;
}
