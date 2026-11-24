import { rename, rm } from 'node:fs/promises';
import type { RouterInstance } from '@koa/router';
import sql, { empty } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { isOwnerOrRole } from '../../roles.js';
import { picturesDir } from './constants.js';
import { LicenseSchema } from './licenses.js';
import { galleryPictureId, PictureIdParamSchema } from './pictureId.js';
import { RotationSchema, rotateJpeg } from './rotation.js';
import { setPictureTags } from './tags.js';

const BodySchema = z.strictObject({
  position: z.strictObject({
    lat: z.number(),
    lon: z.number(),
  }),
  azimuth: z.number().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  takenAt: z.iso.datetime().nullish(),
  tags: z
    .array(z.string().max(255))
    .max(50)
    .nullish()
    .meta({ description: 'names of tags, created where new' }),
  tagIds: z.array(z.uint32()).max(50).nullish(),
  premium: z.boolean().optional(),
  license: LicenseSchema.optional(),
  rotation: RotationSchema.optional(),
});

export function attachPutPictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}', {
    put: {
      summary: 'Update gallery picture metadata',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: PictureIdParamSchema }),
      },
      requestBody: {
        content: {
          'application/json': {
            schema: BodySchema,
          },
        },
      },
      responses: {
        204: {},
        400: {},
        401: {},
        403: {},
        404: { description: 'no such picture' },
        405: { description: 'a Wikimedia Commons photo' },
      },
    },
  });

  router.put(
    '/pictures/:id',
    authenticator(true, 'gallery:write'),
    async (ctx) => {
      const id = galleryPictureId(ctx, true);

      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const {
        title,
        description,
        takenAt,
        position: { lat, lon },
        tags = [],
        tagIds = [],
        azimuth,
        premium,
        license,
        rotation,
      } = body;

      await runInTransaction(async (conn) => {
        const rows = await conn.query<
          {
            userId: number;
            license: string;
            pathname: string;
            pano: boolean;
          }[]
        >(
          sql`SELECT userId, license, pathname, pano FROM picture WHERE id = ${id} FOR UPDATE`,
        );

        if (rows.length === 0) {
          ctx.throw(404, 'no such picture');
        }

        if (
          !isOwnerOrRole(ctx.state.user, rows[0].userId, 'galleryModerator')
        ) {
          ctx.throw(403);
        }

        const licenseChanged =
          license !== undefined && license !== rows[0].license;

        const queries = [
          conn.query<unknown>(sql`
          UPDATE picture SET
            title = ${title},
            description = ${description},
            takenAt = ${takenAt ? new Date(takenAt) : null},
            location = POINT(${lon}, ${lat}),
            azimuth = ${azimuth}
            ${premium === undefined ? empty : sql`, premium = ${premium}`}
            ${license === undefined ? empty : sql`, license = ${license}`}
            WHERE id = ${id}
        `),
        ];

        if (licenseChanged) {
          queries.push(
            conn.query<unknown>(
              sql`INSERT INTO pictureLicenseHistory (pictureId, license) VALUES (${id}, ${license})`,
            ),
          );
        }

        await Promise.all(queries);

        // Not in the Promise.all: its queries run in turn, and a sibling's
        // rejection would release the connection while they still run.
        await setPictureTags(conn, id, tags, tagIds);

        // Last, and under the row lock, which serializes concurrent rotations;
        // the new mtime changes the image's ETag.
        // TODO: a PUT retried after a lost 204 turns the photo again.
        if (rotation && !rows[0].pano) {
          const path = `${picturesDir}/${rows[0].pathname}`;

          try {
            await rotateJpeg(path, `${path}.tmp`, rotation);

            await rename(`${path}.tmp`, path);
          } finally {
            await rm(`${path}.tmp`, { force: true });
          }
        }
      });

      ctx.status = 204;
    },
  );
}
