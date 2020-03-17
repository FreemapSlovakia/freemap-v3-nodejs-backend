import Router from '@koa/router';

import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import {
  acceptValidator,
  contentTypeValidator,
  bodySchemaValidator,
} from '../../requestValidators';
import uuidBase62 from 'uuid-base62';
import { authenticator } from '../../authenticator';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { PICTURES_DIR } from '../../routers/gallery/constants';

const execFileAsync = promisify(execFile);

export function attachPostPictureHandler(router: Router) {
  router.post(
    '/pictures',
    authenticator(true),
    contentTypeValidator('multipart/form-data'),
    async (ctx, next) => {
      const { files } = ctx.request;
      if (!files || !files.image) {
        ctx.body = {
          error: 'missing_image_file',
        };

        ctx.throw(400);
      }

      if (files.image.size > 20 * 1024 * 1024) {
        ctx.throw(413);
      }

      if (!ctx.request.body.meta) {
        ctx.body = {
          error: 'missing_meta_field',
        };

        ctx.throw(400);
      }

      if (typeof ctx.request.body.meta === 'string') {
        ctx.request.body.meta = JSON.parse(ctx.request.body.meta);
      }

      await next();
    },
    bodySchemaValidator(
      {
        type: 'object',
        required: ['meta'],
        properties: {
          meta: {
            type: 'object',
            required: ['position'],
            properties: {
              position: {
                type: 'object',
                required: ['lat', 'lon'],
                properties: {
                  lat: {
                    type: 'number',
                  },
                  lon: {
                    type: 'number',
                  },
                },
              },
              name: {
                type: ['string', 'null'],
              },
              description: {
                type: ['string', 'null'],
              },
              takenAt: {
                type: ['string', 'null'],
                format: 'date-time',
              },
              tags: {
                type: ['array', 'null'],
                items: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
      true,
    ),
    acceptValidator('application/json'),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn;

      const { image } = ctx.request.files;

      const {
        title,
        description,
        takenAt,
        position: { lat, lon },
        tags = [],
      } = ctx.request.body.meta;

      const name = uuidBase62.v4();

      await execFileAsync('exiftran', [
        '-a',
        image.path,
        '-o',
        `${PICTURES_DIR}/${name}.jpeg`,
      ]);

      const { insertId } = await conn.query(SQL`
        INSERT INTO picture SET
          pathname = ${`${name}.jpeg`},
          userId = ${ctx.state.user.id},
          title = ${title},
          description = ${description},
          createdAt = ${new Date()},
          takenAt = ${takenAt ? new Date(takenAt) : null},
          lat = ${lat},
          lon = ${lon}
      `);

      if (tags.length) {
        await conn.query(
          `INSERT INTO pictureTag (name, pictureId) VALUES ${tags
            .map(() => '(?, ?)')
            .join(', ')} ON DUPLICATE KEY UPDATE name = name`,
          [].concat(...tags.map((tag: any) => [tag, insertId])),
        );
      }

      ctx.body = { id: insertId };
    },
  );
}
