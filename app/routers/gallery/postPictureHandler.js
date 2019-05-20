const { dbMiddleware } = require('~/database');
const { acceptValidator, contentTypeValidator, bodySchemaValidator } = require('~/requestValidators');
const postPictureSchema = require('./postPictureSchema');
const uuidBase62 = require('uuid-base62');
const authenticator = require('~/authenticator');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { PICTURES_DIR } = require('~/routers/gallery/constants');

const execFileAsync = promisify(execFile);

module.exports = function attachPostPictureHandler(router) {
  router.post(
    '/pictures',
    dbMiddleware(),
    authenticator(true),
    contentTypeValidator('multipart/form-data'),
    async (ctx, next) => {
      const { files } = ctx.request;
      if (!files || !files.image) {
        ctx.status = 400;
        ctx.body = {
          error: 'missing_image_file',
        };
      } else if (files.image.size > 10 * 1024 * 1024) {
        ctx.status = 413;
      } else if (ctx.request.body.meta) {
        if (typeof ctx.request.body.meta === 'string') {
          ctx.request.body.meta = JSON.parse(ctx.request.body.meta);
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
      const { image } = ctx.request.files;
      const { title, description, takenAt, position: { lat, lon }, tags = [] } = ctx.request.body.meta;

      const name = uuidBase62.v4();

      await execFileAsync('exiftran', ['-a', image.path, '-o', `${PICTURES_DIR}/${name}.jpeg`]);

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO picture (pathname, userId, title, description, createdAt, takenAt, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`${name}.jpeg`, ctx.state.user.id, title, description, new Date(), takenAt ? new Date(takenAt) : null, lat, lon],
      );

      if (tags.length) {
        await ctx.state.db.query(
          `INSERT INTO pictureTag (name, pictureId) VALUES ${tags.map(() => '(?, ?)').join(', ')} ON DUPLICATE KEY UPDATE name = name`,
          [].concat(...tags.map(tag => ([tag, insertId]))),
        );
      }

      ctx.body = { id: insertId };
    },
  );
};
