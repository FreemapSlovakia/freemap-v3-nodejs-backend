const fs = require('fs-extra');
const { dbMiddleware } = require('~/database');
const { acceptValidator, contentTypeValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureSchema = require('./postPictureSchema');
const uuidBase62 = require('uuid-base62');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.post(
    '/picture',
    contentTypeValidator('multipart/form-data'),
    bodySchemaValidator(postPictureSchema, true),
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      const file = ctx.request.body.files.image;
      const { title, description, lat, lon } = JSON.parse(ctx.request.body.fields.meta);

      const name = uuidBase62.v4();

      await fs.copy(file.path, `${global.rootDir}/user_data/pictures/${name}.jpg`); // TODO file.type

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO picture (pathname, userId, title, description, createdAt, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, 0, title, description, new Date(), lat, lon],
      );

      ctx.body = { id: insertId };
    },
  );
};
