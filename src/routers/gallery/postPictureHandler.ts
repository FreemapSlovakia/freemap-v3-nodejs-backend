import Router from '@koa/router';
import { execFile } from 'child_process';
import ExifReader from 'exifreader';
import { promisify } from 'node:util';
import sql from 'sql-template-tag';
import { contentTypeMiddleware } from 'src/contentTypeMiddleware.js';
import uuidBase62 from 'uuid-base62';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import {
  acceptValidator,
  bodySchemaValidator,
} from '../../requestValidators.js';
import { picturesDir } from '../../routers/gallery/constants.js';

const execFileAsync = promisify(execFile);

export function attachPostPictureHandler(router: Router) {
  router.post(
    '/pictures',
    authenticator(true),
    contentTypeMiddleware({
      'application/json': [
        bodySchemaValidator({
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['setAllPremium'],
            },
            payload: {
              type: 'boolean',
            },
          },
        }),
        async (ctx, next) => {
          const premium = ctx.request.body.payload;

          await pool.query(
            sql`UPDATE picture SET premium = ${premium} WHERE useId = ${ctx.state.user!.id}`,
          );
        },
      ],
      'multipart/form-data': [
        async (ctx, next) => {
          const { files } = ctx.request;

          if (!files || !files.image) {
            return ctx.throw(400, 'missing image file');
          }

          if (
            Array.isArray(files.image) ||
            files.image.size > 40 * 1024 * 1024
          ) {
            ctx.throw(413);
          }

          if (!ctx.request.body.meta) {
            ctx.throw(400, 'missing meta field');
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
                  premium: {
                    type: 'boolean',
                  },
                },
              },
            },
          },
          true,
        ),
        acceptValidator('application/json'),
        runInTransaction(),
        async (ctx) => {
          const conn = ctx.state.dbConn!;

          const { image } = ctx.request.files!;

          if (Array.isArray(image)) {
            ctx.status = 400;
            return;
          }

          const {
            title,
            description,
            takenAt,
            position: { lat, lon },
            tags = [],
            premium,
          } = ctx.request.body.meta;

          const name = uuidBase62.v4();

          const [exif] = await Promise.all([
            ExifReader.load(image.filepath),

            await execFileAsync('exiftran', [
              '-a',
              image.filepath,
              '-o',
              `${picturesDir}/${name}.jpeg`,
            ]),
          ]);

          const pano = exif['UsePanoramaViewer']?.value === 'True';

          const { insertId } = await conn.query(sql`
          INSERT INTO picture SET
            pathname = ${`${name}.jpeg`},
            userId = ${ctx.state.user!.id},
            title = ${title},
            description = ${description},
            createdAt = ${new Date() as any},
            takenAt = ${takenAt ? (new Date(takenAt) as any) : null},
            lat = ${lat},
            lon = ${lon},
            pano = ${pano},
            premium = ${premium}
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
      ],
    }),
  );
}
