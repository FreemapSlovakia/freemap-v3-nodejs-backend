import { RouterInstance } from '@koa/router';
import { createHmac } from 'node:crypto';
import sql, { empty, raw } from 'sql-template-tag';
import { assertGuard } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { acceptValidator } from '../../requestValidators.js';
import { ratingSubquery } from './ratingConstants.js';
import { PictureRow } from './types.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

export function attachGetPictureHandler(router: RouterInstance) {
  router.get(
    '/pictures/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [row] = await pool.query(
        sql`SELECT picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, picture.lat, picture.lon, azimuth, pano,
          user.id as userId, user.name, premium,
          (SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags, ${raw(ratingSubquery)}
          ${
            ctx.state.user
              ? sql`, (SELECT stars FROM pictureRating WHERE pictureId = picture.id AND userId = ${ctx.state.user!.id}) AS myStars`
              : empty
          }
          FROM picture LEFT JOIN user ON userId = user.id WHERE picture.id = ${ctx.params.id}`,
      );

      if (!row) {
        ctx.throw(404, 'no such picture');
      }

      assertGuard<
        Omit<PictureRow, 'id'> & {
          name: string;
          pictureId: number;
          tags: string | null;
          rating: number;
          myStars?: number | null;
        }
      >(row);

      const commentRows = await pool.query(sql`
        SELECT pictureComment.id, pictureComment.createdAt, comment, user.name, userId
          FROM pictureComment JOIN user ON (userId = user.id)
          WHERE pictureId = ${ctx.params.id}
          ORDER BY pictureComment.createdAt
      `);

      assertGuard<
        {
          id: number;
          createdAt: Date;
          comment: string;
          userId: number;
          name: string;
        }[]
      >(commentRows);

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
