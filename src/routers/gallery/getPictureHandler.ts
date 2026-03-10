import { createHmac } from 'node:crypto';
import { RouterInstance } from '@koa/router';
import sql, { empty, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { ratingSubquery } from './ratingConstants.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

const PictureDbRowSchema = z.object({
  pictureId: z.uint32(),
  createdAt: z.date(),
  pathname: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  takenAt: z.date().nullable(),
  lat: z.number(),
  lon: z.number(),
  azimuth: z.number().nullable(),
  pano: z.union([z.boolean(), z.number()]),
  userId: z.uint32().nullable(),
  name: z.string().nullable(),
  premium: z.union([z.boolean(), z.number()]),
  tags: z.string().nullable(),
  rating: z.number(),
  myStars: z.number().nullable().optional(),
});

const CommentDbRowSchema = z.object({
  id: z.uint32(),
  createdAt: z.date(),
  comment: z.string(),
  userId: z.uint32(),
  name: z.string(),
});

export function attachGetPictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}', {
    get: {
      security: AUTH_OPTIONAL,
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'integer' },
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {},
          },
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
          await pool.query(
            sql`SELECT picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, ST_X(location) AS lon, ST_Y(location) AS lat, azimuth, pano,
          user.id as userId, user.name, premium,
          (SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags, ${raw(ratingSubquery)}
          ${
            ctx.state.user
              ? sql`, (SELECT stars FROM pictureRating WHERE pictureId = picture.id AND userId = ${ctx.state.user!.id}) AS myStars`
              : empty
          }
          FROM picture LEFT JOIN user ON userId = user.id WHERE picture.id = ${ctx.params.id}`,
          ),
        );

      if (!row) {
        ctx.throw(404, 'no such picture');
      }

      const commentRows = CommentDbRowSchema.array().parse(
        await pool.query(sql`
          SELECT pictureComment.id, pictureComment.createdAt, comment, user.name, userId
            FROM pictureComment JOIN user ON (userId = user.id)
            WHERE pictureId = ${ctx.params.id}
            ORDER BY pictureComment.createdAt
        `),
      );

      const comments = commentRows.map(
        ({ id, createdAt, comment, userId, name }) => ({
          id,
          createdAt: createdAt.toISOString(),
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
      } = row;

      const hmac =
        premium && secret
          ? createHmac('sha256', secret).update(String(pictureId)).digest('hex')
          : undefined;

      ctx.body = {
        id: pictureId,
        createdAt: createdAt.toISOString(),
        title,
        description,
        takenAt:
          takenAt instanceof Date && !Number.isNaN(takenAt.getTime())
            ? takenAt.toISOString()
            : null,
        lat,
        lon,
        azimuth,
        user: userId && {
          id: userId,
          name,
        },
        tags: tags ? tags.split('\n') : [],
        comments,
        rating,
        myStars,
        pano: pano ? 1 : undefined,
        premium: premium ? 1 : undefined,
        hmac,
      };
    },
  );
}
