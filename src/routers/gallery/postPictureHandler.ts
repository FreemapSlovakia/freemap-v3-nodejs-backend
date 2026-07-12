import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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
import { DEFAULT_PHOTO_LICENSE, LicenseSchema } from './licenses.js';

const execFileAsync = promisify(execFile);

// The bulk action posted as JSON, discriminated on `action` so each action's
// payload is validated together with it.
const SetAllBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('setAllPremiumOrFree'),
    payload: z.enum(['premium', 'free']),
  }),
  z.object({
    action: z.literal('setAllLicense'),
    payload: LicenseSchema,
  }),
]);

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
  license: LicenseSchema.default(DEFAULT_PHOTO_LICENSE),
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
            body = SetAllBodySchema.parse(ctx.request.body);
          } catch (err) {
            return ctx.throw(400, err as Error);
          }

          const userId = ctx.state.user!.id;

          if (body.action === 'setAllLicense') {
            const { payload: license } = body;

            await runInTransaction(async (conn) => {
              const changed = await conn.query<{ id: number }[]>(
                sql`SELECT id FROM picture WHERE userId = ${userId} AND license <> ${license} FOR UPDATE`,
              );

              if (changed.length) {
                await conn.query<unknown>(
                  sql`UPDATE picture SET license = ${license} WHERE userId = ${userId} AND license <> ${license}`,
                );

                await conn.query<unknown>(
                  sql`INSERT INTO pictureLicenseHistory (pictureId, license) VALUES ${bulk(
                    changed.map((row) => [row.id, license]),
                  )}`,
                );
              }
            });

            ctx.status = 204;

            return;
          }

          const premium = body.payload === 'premium';

          await pool.query<unknown>(
            sql`UPDATE picture SET premium = ${premium} WHERE userId = ${userId}`,
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
            license,
          } = meta;

          const name = shortUuid.generate();

          // Shard by the first two characters of the filename to avoid one huge
          // directory; the same rule is applied by the DB migration.
          const relPath = `${name.slice(0, 2)}/${name}.jpeg`;

          const outPath = `${picturesDir}/${relPath}`;

          await mkdir(dirname(outPath), { recursive: true });

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

          // The client's pannellum viewer only renders equirectangular
          // panoramas. A cylindrical GPano pano (Hugin) has no pannellum
          // projection and gets stretched into a fake full sphere, so leave it
          // (and any other explicit non-equirectangular projection) as a
          // regular image. A missing ProjectionType is treated as
          // equirectangular — the GPano default, and what pannellum assumes.
          const projectionType = exif.ProjectionType?.value;

          const pano =
            exif.UsePanoramaViewer?.value === 'True' &&
            (projectionType === undefined ||
              projectionType === 'equirectangular');

          const createdAt = new Date();

          const id = await runInTransaction(async (conn) => {
            const { insertId } = await conn.query<{ insertId: number }>(sql`
              INSERT INTO picture SET
                pathname = ${relPath},
                userId = ${ctx.state.user!.id},
                title = ${title},
                description = ${description},
                createdAt = ${createdAt},
                takenAt = ${takenAt ? new Date(takenAt) : null},
                location = POINT(${lon}, ${lat}),
                azimuth = ${azimuth},
                pano = ${pano},
                premium = ${premium},
                license = ${license}
            `);

            await conn.query<unknown>(
              sql`INSERT INTO pictureLicenseHistory (pictureId, license, changedAt) VALUES (${insertId}, ${license}, ${createdAt})`,
            );

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
