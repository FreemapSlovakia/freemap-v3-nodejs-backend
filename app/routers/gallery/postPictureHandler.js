const SQL = require('sql-template-strings');
const { dbMiddleware } = require('~/database');
const {
  acceptValidator,
  contentTypeValidator,
  bodySchemaValidator,
} = require('~/requestValidators');
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
        ctx.body = {
          error: 'missing_image_file',
        };

        ctx.throw(400);
      }

      if (files.image.size > 20 * 1024 * 1024) {
        ctx.throw(413);
      }

      if (!ctx.request.body.meta) {
        ctx.body = {
          error: 'missing_meta_field',
        };

        ctx.throw(400);
      }

      if (typeof ctx.request.body.meta === 'string') {
        ctx.request.body.meta = JSON.parse(ctx.request.body.meta);
      }

      await next();
    },
    bodySchemaValidator(postPictureSchema, true),
    acceptValidator('application/json'),
    async ctx => {
      const { image } = ctx.request.files;
      const {
        title,
        description,
        takenAt,
        position: { lat, lon },
        tags = [],
      } = ctx.request.body.meta;

      const name = uuidBase62.v4();

      await execFileAsync('exiftran', [
        '-a',
        image.path,
        '-o',
        `${PICTURES_DIR}/${name}.jpeg`,
      ]);

      const { insertId } = await ctx.state.db.query(SQL`
        INSERT INTO picture SET
          pathname = ${`${name}.jpeg`},
          userId = ${ctx.state.user.id},
          title = ${title},
          description = ${description},
          createdAt = ${new Date()},
          takenAt = ${takenAt ? new Date(takenAt) : null},
          lat = ${lat},
          lon = ${lon}
      `);

      if (tags.length) {
        await ctx.state.db.query(
          `INSERT INTO pictureTag (name, pictureId) VALUES ${tags
            .map(() => '(?, ?)')
            .join(', ')} ON DUPLICATE KEY UPDATE name = name`,
          [].concat(...tags.map(tag => [tag, insertId])),
        );
      }

      ctx.body = { id: insertId };
    },
  );
};
