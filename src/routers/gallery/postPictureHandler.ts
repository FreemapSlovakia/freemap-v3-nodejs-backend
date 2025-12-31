import { RouterInstance } from '@koa/router';
import { execFile } from 'child_process';
import ExifReader from 'exifreader';
import { promisify } from 'node:util';
import shortUuid from 'short-uuid';
import sql, { bulk } from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { contentTypeMiddleware } from '../../contentTypeMiddleware.js';
import { pool, runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { picturesDir } from '../../routers/gallery/constants.js';

const execFileAsync = promisify(execFile);

export function attachPostPictureHandler(router: RouterInstance) {
  router.post(
    '/pictures',
    authenticator(true),
    contentTypeMiddleware({
      'application/json': [
        async (ctx) => {
          type Body = {
            type?: 'setAllPremiumOrFree';
            payload?: 'premium' | 'free';
          };

          let body;

          try {
            body = assert<Body>(ctx.request.body);
          } catch (err) {
            return ctx.throw(400, err as Error);
          }

          const premium = body.payload === 'premium';

          await pool.query(
            sql`UPDATE picture SET premium = ${premium} WHERE userId = ${ctx.state.user!.id}`,
          );

          ctx.status = 204;
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

          let body;

          try {
            body = assert<{ meta: string }>(ctx.request.body);
          } catch (err) {
            return ctx.throw(400, err as Error);
          }

          if (typeof body.meta === 'string') {
            body.meta = JSON.parse(body.meta);
          }

          await next();
        },
        acceptValidator('application/json'),
        async (ctx) => {
          type Body = {
            meta: {
              position: {
                lat: number & tags.Minimum<-90> & tags.Maximum<90>;
                lon: number & tags.Minimum<-180> & tags.Maximum<180>;
              };
              title?: string | null;
              description?: string | null;
              takenAt?: (string & tags.Format<'date-time'>) | null;
              tags?: string[] | null;
              premium?: boolean;
              azimuth?:
                | (number & tags.Minimum<0> & tags.ExclusiveMaximum<360>)
                | null;
            };
          };

          let body;

          try {
            body = assert<Body>(ctx.request.body);
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
          } = body.meta;

          const name = shortUuid.generate();

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

          const id = await runInTransaction(async (conn) => {
            const { insertId } = await conn.query(sql`
              INSERT INTO picture SET
                pathname = ${`${name}.jpeg`},
                userId = ${ctx.state.user!.id},
                title = ${title},
                description = ${description},
                createdAt = ${new Date()},
                takenAt = ${takenAt ? new Date(takenAt) : null},
                lat = ${lat},
                lon = ${lon},
                azimuth = ${azimuth},
                pano = ${pano},
                premium = ${premium}
            `);

            if (tags?.length) {
              await conn.query(
                sql`INSERT INTO pictureTag (name, pictureId) VALUES ${bulk(tags.map((tag) => [tag, insertId]))} ON DUPLICATE KEY UPDATE name = name`,
              );
            }

            return insertId;
          });

          ctx.body = { id };
        },
      ],
    }),
  );
}
