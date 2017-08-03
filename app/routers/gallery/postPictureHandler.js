const fs = require('fs-extra');
const { dbMiddleware } = require('~/database');
const { acceptValidator, contentTypeValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureSchema = require('./postPictureSchema');
const uuidBase62 = require('uuid-base62');
const authenticator = require('~/authenticator');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.post(
    '/picture',
    dbMiddleware,
    authenticator(true),
    contentTypeValidator('multipart/form-data'),
    async (ctx, next) => {
      const { fields } = ctx.request.body;
      if (fields && fields.meta) {
        try {
          fields.meta = JSON.parse(ctx.request.body.fields.meta);
        } catch (e) {
          ctx.status = 400;
          ctx.body = {
            error: 'invalid_json_in_meta_field',
          };
          return;
        }
        await next();
      } else {
        ctx.status = 400;
        ctx.body = {
          error: 'missing_meta_field',
        };
      }
    },
    bodySchemaValidator(postPictureSchema, true),
    acceptValidator('application/json'),
    async (ctx) => {
      const image = ctx.request.body.files.image;
      const { title, description, position: { lat, lon } } = ctx.request.body.fields.meta;

      const name = uuidBase62.v4();

      await fs.copy(image.path, `${global.rootDir}/user_data/pictures/${name}.jpeg`); // TODO file.type

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO picture (pathname, userId, title, description, createdAt, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [`${name}.jpeg`, ctx.state.user.id, title, description, new Date(), lat, lon],
      );

      ctx.body = { id: insertId };
    },
  );
};
