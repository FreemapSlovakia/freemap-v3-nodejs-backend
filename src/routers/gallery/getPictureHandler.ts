import Router from '@koa/router';
import sql, { empty, raw } from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { ratingSubquery } from './ratingConstants.js';

export function attachGetPictureHandler(router: Router) {
  router.get(
    '/pictures/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const rows = await pool.query(
        sql`SELECT picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, picture.lat, picture.lon, pano,
          user.id as userId, user.name, premium,
          (SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags, ${raw(ratingSubquery)}
          ${
            ctx.state.user
              ? sql`, (SELECT stars FROM pictureRating WHERE pictureId = picture.id AND userId = ${ctx.state.user!.id}) AS myStars`
              : empty
          }
          FROM picture LEFT JOIN user ON userId = user.id WHERE picture.id = ${ctx.params.id}`,
      );

      if (rows.length === 0) {
        ctx.throw(404, 'no such picture');
      }

      const commentRows = await pool.query(sql`
        SELECT pictureComment.id, pictureComment.createdAt, comment, user.name, userId
          FROM pictureComment JOIN user ON (userId = user.id)
          WHERE pictureId = ${ctx.params.id}
          ORDER BY pictureComment.createdAt
      `);

      const comments = commentRows.map(
        ({ id, createdAt, comment, userId, name }: any) => ({
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
        userId,
        name,
        tags,
        rating,
        myStars,
        pano,
        premium,
      } = rows[0];

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
      };
    },
  );
}
