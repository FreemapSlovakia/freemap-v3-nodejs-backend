const { dbMiddleware } = require('~/database');
const { bodySchemaValidator } = require('~/requestValidators');
const putPictureSchema = require('./putPictureSchema');
const authenticator = require('~/authenticator');

module.exports = function attachPutPictureHandler(router) {
  router.put(
    '/pictures/:id',
    dbMiddleware,
    authenticator(true),
    bodySchemaValidator(putPictureSchema),
    async (ctx) => {
      const { title, description, takenAt, position: { lat, lon }, tags = [] } = ctx.request.body;

      const rows = await ctx.state.db.query('SELECT userId FROM picture WHERE id = ? FOR UPDATE', [ctx.params.id]);
      if (rows.length === 0) {
        ctx.status = 404;
        return;
      }

      if (!ctx.state.user.admin && rows[0].userId !== ctx.state.user.id) {
        ctx.status = 403;
        return;
      }
      
      const queries = [
        ctx.state.db.query(
          'UPDATE picture SET title = ?, description = ?, takenAt = ?, lat = ?, lon = ? WHERE id = ?',
          [title, description, takenAt ? new Date(takenAt) : null, lat, lon, ctx.params.id],
        ),
        // delete missing tags
        ctx.state.db.query(
          `DELETE FROM pictureTag WHERE pictureId = ?${tags.length ? ` AND name NOT IN (${tags.map(() => '?').join(', ')})` : ''}`,
          [ctx.params.id, ...tags],
        ),
      ];

      if (tags.length) {
        queries.push(
          ctx.state.db.query(
            `INSERT INTO pictureTag (name, pictureId) VALUES ${tags.map(() => '(?, ?)').join(', ')} ON DUPLICATE KEY UPDATE name = name`,
            [].concat(...tags.map(tag => ([tag, ctx.params.id]))),
          ),
        );
      }

      await Promise.all(queries);
      ctx.status = 204;
    },
  );
};
