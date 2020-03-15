const SQL = require('sql-template-strings');
const randomize = require('randomatic');
const { runInTransaction } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const putDeviceSchema = require('./putDeviceSchema');

module.exports = router => {
  router.put(
    '/devices/:id',
    acceptValidator('application/json'),
    bodySchemaValidator(putDeviceSchema, true),
    authenticator(true),
    runInTransaction(),
    async ctx => {
      const { id } = ctx.params;

      const conn = ctx.state.dbConn;

      const [item] = await conn.query(
        SQL`SELECT userId FROM trackingDevice WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const { name, maxCount, maxAge, regenerateToken } = ctx.request.body;
      let token;

      if (regenerateToken) {
        token = randomize('Aa0', 8);
      }

      await conn.query(
        SQL`UPDATE trackingDevice SET name = ${name}, maxCount = ${maxCount}, maxAge = ${maxAge}`
          .append(regenerateToken ? SQL`, token = ${token}` : '')
          .append(SQL`WHERE id = ${id}`),
      );

      if (maxAge) {
        await conn.query(SQL`
        DELETE FROM trackingPoint WHERE deviceId = ${id} AND TIMESTAMPDIFF(SECOND, createdAt, now()) > ${maxAge}
      `);
      }

      if (maxCount) {
        await conn.query(SQL`
        DELETE t FROM trackingPoint AS t
          JOIN (
            SELECT id FROM trackingPoint WHERE deviceId = ${id}
              ORDER BY id DESC LIMIT 18446744073709551615, ${maxCount + 1}
          ) tlimit ON t.id = tlimit.id
      `);
      }

      ctx.body = { token };
    },
  );
};
