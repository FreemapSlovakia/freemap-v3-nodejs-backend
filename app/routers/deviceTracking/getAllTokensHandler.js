const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    authenticator(true),
    async ctx => {
      const [device] = await pool.query(
        SQL`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id}`,
      );

      if (!device) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && ctx.state.user.id !== device.userId) {
        ctx.throw(403);
      }

      ctx.body = await pool.query(SQL`
        SELECT id, token, createdAt, timeFrom, timeTo, note, listingLabel
          FROM trackingAccessToken WHERE deviceId = ${ctx.params.id}
      `);
    },
  );
};
