const SQL = require('sql-template-strings');
const { dbMiddleware } = require('~/database');
const { bodySchemaValidator } = require('~/requestValidators');
const putPictureSchema = require('./putPictureSchema');
const authenticator = require('~/authenticator');

module.exports = function attachPutPictureHandler(router) {
  router.put(
    '/pictures/:id',
    dbMiddleware(),
    authenticator(true),
    bodySchemaValidator(putPictureSchema),
    async ctx => {
      const {
        title,
        description,
        takenAt,
        position: { lat, lon },
        tags = [],
      } = ctx.request.body;

      const rows = await ctx.state.db.query(
        SQL`SELECT userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && rows[0].userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const queries = [
        ctx.state.db.query(SQL`
          UPDATE picture SET
            title = ${title},
            description = ${description},
            takenAt = ${takenAt ? new Date(takenAt) : null},
            lat = ${lat},
            lon = ${lon}
            WHERE id = ${ctx.params.id}
        `),

        // delete missing tags
        ctx.state.db.query(
          `DELETE FROM pictureTag WHERE pictureId = ?
            ${
              tags.length
                ? ` AND name NOT IN (${tags.map(() => '?').join(', ')})`
                : ''
            }`,
          [ctx.params.id, ...tags],
        ),
      ];

      if (tags.length) {
        queries.push(
          ctx.state.db.query(
            `INSERT INTO pictureTag (name, pictureId)
              VALUES ${tags.map(() => '(?, ?)').join(', ')}
              ON DUPLICATE KEY UPDATE name = name`,
            [].concat(...tags.map(tag => [tag, ctx.params.id])),
          ),
        );
      }

      await Promise.all(queries);

      ctx.status = 204;
    },
  );
};
