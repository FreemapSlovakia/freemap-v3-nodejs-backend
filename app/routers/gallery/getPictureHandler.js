const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { ratingSubquery } = require('./ratingConstants');

module.exports = function attachGetPictureHandler(router) {
  router.get(
    '/pictures/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async ctx => {
      const rows = await pool.query(
        SQL`SELECT picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, picture.lat, picture.lon,
          user.id as userId, user.name,
          (SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags,`
          .append(ratingSubquery)
          .append(
            ctx.state.user
              ? `, (SELECT stars FROM pictureRating WHERE pictureId = picture.id AND userId = ${ctx.state.user.id}) AS myStars`
              : '',
          )
          .append(
            SQL`FROM picture LEFT JOIN user ON userId = user.id WHERE picture.id = ${ctx.params.id}`,
          ),
      );

      if (rows.length === 0) {
        ctx.throw(404);
      }

      const commentRows = await pool.query(SQL`
        SELECT pictureComment.id, pictureComment.createdAt, comment, user.name, userId
          FROM pictureComment JOIN user ON (userId = user.id)
          WHERE pictureId = ${ctx.params.id}
          ORDER BY pictureComment.createdAt
      `);

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
        userId,
        name,
        tags,
        rating,
        myStars,
      } = rows[0];

      ctx.body = {
        id: pictureId,
        createdAt: createdAt.toISOString(),
        title,
        description,
        takenAt:
          takenAt instanceof Date && !Number.isNaN(takenAt)
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
      };
    },
  );
};
