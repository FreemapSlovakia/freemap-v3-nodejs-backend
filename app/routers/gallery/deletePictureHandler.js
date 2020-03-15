const SQL = require('sql-template-strings');
const { runInTransaction } = require('~/database');
const authenticator = require('~/authenticator');
const { promisify } = require('util');
const { unlink } = require('fs');

const unlinkAsync = promisify(unlink);
const { PICTURES_DIR } = require('~/routers/gallery/constants');

module.exports = function attachDeletePictureHandler(router) {
  router.delete(
    '/pictures/:id',
    authenticator(true),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn;

      const rows = await conn.query(
        SQL`SELECT pathname, userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && rows[0].userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      await conn.query(SQL`DELETE FROM picture WHERE id = ${ctx.params.id}`);

      await unlinkAsync(`${PICTURES_DIR}/${rows[0].pathname}`);

      ctx.status = 204;
    },
  );
};
