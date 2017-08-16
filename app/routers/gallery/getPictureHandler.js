const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = function attachGetPictureHandler(router) {
  router.get(
    '/pictures/:id',
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      const rows = await ctx.state.db.query(
        `SELECT picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, picture.lat, picture.lon, user.id as userId, user.name,
          (SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags
        FROM picture LEFT JOIN user ON userId = user.id WHERE picture.id = ?`,
        [ctx.params.id],
      );

      if (rows.length) {
        const { pictureId, createdAt, title, description, takenAt, lat, lon, userId, name, tags } = rows[0];
        ctx.body = {
          id: pictureId,
          createdAt: createdAt.toISOString(),
          title,
          description,
          takenAt: takenAt ? takenAt.toISOString() : null,
          lat,
          lon,
          user: userId && {
            id: userId,
            name,
          },
          tags: tags ? tags.split('\n') : [],
        };
      } else {
        ctx.status = 404;
      }
    },
  );
};
