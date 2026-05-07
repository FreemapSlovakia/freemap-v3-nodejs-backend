import { createHmac } from 'node:crypto';
import { type } from 'node:os';
import { RouterInstance } from '@koa/router';
import sql, { empty, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso, zNullableDateToIso } from '../../types.js';
import { ratingSubquery } from './ratingConstants.js';
import { stat } from 'node:fs/promises';
import { picturesDir } from './constants.js';
import path from 'node:path';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

const PictureDbRowSchema = z.object({
  pictureId: z.uint32(),
  createdAt: zDateToIso,
  pathname: z.string().nonempty(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  takenAt: zNullableDateToIso,
  lat: z.number(),
  lon: z.number(),
  azimuth: z.number().nullable(),
  pano: z.boolean(),
  userId: z.uint32().nullable(),
  name: z.string().nullable(),
  premium: z.boolean(),
  tags: z
    .string()
    .nullable()
    .transform((t) => (t ? t.split('\n') : []))
    .pipe(z.array(z.string())),
  rating: z.number(),
  myStars: z.number().nullish(),
});

const CommentDbRowSchema = z.object({
  id: z.uint32(),
  createdAt: zDateToIso,
  comment: z.string(),
  userId: z.uint32(),
  name: z.string(),
});

const ResponseBodySchema = PictureDbRowSchema.omit({
  pictureId: true,
  pathname: true,
  userId: true,
  name: true,
}).extend({
  id: z.uint32(),
  user: z
    .strictObject({
      id: z.uint32(),
      name: z.string(),
    })
    .nullable(),
  comments: CommentDbRowSchema.omit({ userId: true, name: true })
    .extend({
      user: z.strictObject({
        id: z.uint32(),
        name: z.string(),
      }),
    })
    .array(),
  hmac: z.string().optional(),
  size: z.number().optional(),
});

type ResponseBody = z.infer<typeof ResponseBodySchema>;

export function attachGetPictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}', {
    get: {
      summary: 'Get a single gallery picture',
      tags: ['gallery'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseBodySchema } },
        },
        401: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.get(
    '/pictures/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [row] = PictureDbRowSchema.array()
        .max(1)
        .parse(
          await pool.query<unknown>(sql`
            SELECT picture.id AS pictureId, picture.createdAt, pathname, title, picture.description, takenAt, ST_X(location) AS lon, ST_Y(location) AS lat, azimuth, pano,
              user.id as userId, user.name, premium,
              (SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags, ${raw(ratingSubquery)}
              ${
                ctx.state.user
                  ? sql`, (SELECT stars FROM pictureRating WHERE pictureId = picture.id AND userId = ${ctx.state.user!.id}) AS myStars`
                  : empty
              }
            FROM picture LEFT JOIN user ON userId = user.id
            WHERE picture.id = ${ctx.params.id}`),
        );

      if (!row) {
        ctx.throw(404, 'no such picture');
      }

      const commentRows = CommentDbRowSchema.array().parse(
        await pool.query<unknown>(sql`
          SELECT pictureComment.id, pictureComment.createdAt, comment, user.name, userId
            FROM pictureComment JOIN user ON (userId = user.id)
            WHERE pictureId = ${ctx.params.id}
            ORDER BY pictureComment.createdAt
        `),
      );

      const comments = commentRows.map(
        ({ id, createdAt, comment, userId, name }) => ({
          id,
          createdAt,
          comment,
          user: {
            id: userId,
            name,
          },
        }),
      );

      const {
        pictureId,
        createdAt,
        title,
        description,
        takenAt,
        lat,
        lon,
        azimuth,
        userId,
        name,
        tags,
        rating,
        myStars,
        pano,
        premium,
        pathname,
      } = row;

      let size;
      try {
        size = (await stat(path.join(picturesDir, pathname))).size;
      } catch {
        // ignore
      }

      ctx.body = {
        id: pictureId,
        createdAt,
        title,
        description,
        takenAt,
        lat,
        lon,
        azimuth,
        user:
          userId === null || name === null
            ? null
            : {
                id: userId,
                name,
              },
        tags,
        comments,
        rating,
        myStars,
        pano,
        premium,
        hmac:
          premium && secret
            ? createHmac('sha256', secret)
                .update(String(pictureId))
                .digest('hex')
            : undefined,
        size,
      } satisfies ResponseBody;
    },
  );
}
