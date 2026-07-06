import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RouterInstance } from '@koa/router';
import ExifReader from 'exifreader';
import shortUuid from 'short-uuid';
import sql, { bulk } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { contentTypeMiddleware } from '../../contentTypeMiddleware.js';
import { pool, runInTransaction } from '../../database.js';
import { isHeifFile } from '../../heif.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { picturesDir } from '../../routers/gallery/constants.js';

const execFileAsync = promisify(execFile);

const SetAllPremiumBodySchema = z.strictObject({
  type: z.literal('setAllPremiumOrFree').optional(),
  payload: z.enum(['premium', 'free']).optional(),
});

const MetaSchema = z.strictObject({
  position: z.strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
  title: z.string().nullish(),
  description: z.string().nullish(),
  takenAt: z.iso.datetime().nullish(),
  tags: z.array(z.string()).nullish(),
  premium: z.boolean().optional(),
  azimuth: z.number().min(0).lt(360).nullish(),
});

const MultipartBodySchema = z.object({ meta: z.unknown() });

const ResponseSchema = z.strictObject({ id: z.uint32() });

export function attachPostPictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures', {
    post: {
      summary: 'Upload a new gallery picture',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      responses: {
        204: {},
        201: {
          content: {
            'application/json': {
              schema: ResponseSchema,
            },
          },
        },
        400: {},
        401: {},
        413: { description: 'image too large' },
      },
    },
  });

  router.post(
    '/pictures',
    authenticator(true),
    contentTypeMiddleware({
      'application/json': [
        async (ctx) => {
          let body;

          try {
            body = SetAllPremiumBodySchema.parse(ctx.request.body);
          } catch (err) {
            return ctx.throw(400, err as Error);
          }

          const premium = body.payload === 'premium';

          await pool.query<unknown>(
            sql`UPDATE picture SET premium = ${premium} WHERE userId = ${ctx.state.user!.id}`,
          );

          ctx.status = 204;
        },
      ],
      'multipart/form-data': [
        async (ctx, next) => {
          const { files } = ctx.request;

          if (!files?.image) {
            return ctx.throw(400, 'missing image file');
          }

          if (
            Array.isArray(files.image) ||
            files.image.size > 40 * 1024 * 1024
          ) {
            ctx.throw(413, 'image too large');
          }

          let body;

          try {
            body = MultipartBodySchema.parse(ctx.request.body);
          } catch (err) {
            return ctx.throw(400, err as Error);
          }

          if (typeof body.meta === 'string') {
            (ctx.request.body as Record<string, unknown>).meta = JSON.parse(
              body.meta,
            );
          }

          await next();
        },
        acceptValidator('application/json'),
        async (ctx) => {
          let meta;

          try {
            meta = MetaSchema.parse(
              (ctx.request.body as Record<string, unknown>).meta,
            );
          } catch (err) {
            return ctx.throw(400, err as Error);
          }

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
            azimuth,
            tags = [],
            premium,
          } = meta;

          const name = shortUuid.generate();

          const outPath = `${picturesDir}/${name}.jpeg`;

          // HEIF can't be processed by exiftran, so re-encode it to JPEG with
          // ImageMagick (applying the EXIF orientation); JPEG is rotated
          // losslessly by exiftran.
          let exif;

          try {
            [exif] = await Promise.all([
              ExifReader.load(image.filepath),

              (await isHeifFile(image.filepath))
                ? execFileAsync('convert', [
                    image.filepath,
                    '-auto-orient',
                    '-quality',
                    '85',
                    outPath,
                  ])
                : execFileAsync('exiftran', [
                    '-a',
                    image.filepath,
                    '-o',
                    outPath,
                  ]),
            ]);
          } catch {
            // A malformed or unsupported upload (e.g. not a valid JPEG/HEIF)
            // makes exiftran/convert fail; that's a client error, not a 500.
            return ctx.throw(400, 'invalid or unsupported image file');
          }

          const pano = exif.UsePanoramaViewer?.value === 'True';

          const id = await runInTransaction(async (conn) => {
            const { insertId } = await conn.query<{ insertId: number }>(sql`
              INSERT INTO picture SET
                pathname = ${`${name}.jpeg`},
                userId = ${ctx.state.user!.id},
                title = ${title},
                description = ${description},
                createdAt = ${new Date()},
                takenAt = ${takenAt ? new Date(takenAt) : null},
                location = POINT(${lon}, ${lat}),
                azimuth = ${azimuth},
                pano = ${pano},
                premium = ${premium}
            `);

            if (tags?.length) {
              await conn.query<unknown>(
                sql`INSERT INTO pictureTag (name, pictureId) VALUES ${bulk(tags.map((tag) => [tag, insertId]))} ON DUPLICATE KEY UPDATE name = name`,
              );
            }

            return insertId;
          });

          ctx.status = 201;
          ctx.body = ResponseSchema.parse({ id });
        },
      ],
    }),
  );
}
