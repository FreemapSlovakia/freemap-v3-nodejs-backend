const fs = require('fs-extra');
const { dbMiddleware } = require('~/database');
const { acceptValidator, contentTypeValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureSchema = require('./postPictureSchema');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.post(
    '/picture',
    contentTypeValidator('multipart/form-data'),
    bodySchemaValidator(postPictureSchema),
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      const file = ctx.request.body.files.uploads[0];
      const { title, description, lat, lon } = JSON.parse(ctx.request.body.meta);

      await fs.copy(file.path, `${global.rootDir}/user_data/pictures`);

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO picture (pathname, userId, title, description, createdAt, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['', 0, title, description, new Date(), lat, lon],
      );

      ctx.body = { id: insertId };
    },
  );
};
