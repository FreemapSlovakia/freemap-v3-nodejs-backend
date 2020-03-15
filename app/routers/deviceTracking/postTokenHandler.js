const SQL = require('sql-template-strings');
const randomize = require('randomatic');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const postTokenSchema = require('./postTokenSchema');

module.exports = router => {
  router.post(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    bodySchemaValidator(postTokenSchema, true),
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

      const token = randomize('Aa0', 8);
      const { timeFrom, timeTo, note, listingLabel } = ctx.request.body;

      const { insertId } = await pool.query(SQL`
        INSERT INTO trackingAccessToken SET
          deviceId = ${ctx.params.id},
          token = ${token},
          timeFrom = ${timeFrom && new Date(timeFrom)},
          timeTo = ${timeTo && new Date(timeTo)},
          note = ${note},
          listingLabel = ${listingLabel}
      `);

      ctx.body = { id: insertId, token };
    },
  );
};
