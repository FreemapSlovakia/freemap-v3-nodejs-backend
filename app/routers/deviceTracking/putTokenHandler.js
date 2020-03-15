const SQL = require('sql-template-strings');
const { runInTransaction } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const putTokenSchema = require('./putTokenSchema');

module.exports = router => {
  router.put(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    bodySchemaValidator(putTokenSchema, true),
    authenticator(true),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn;

      const [item] = await conn.query(SQL`
          SELECT userId
            FROM trackingAccessToken
            JOIN trackingDevice ON (deviceId = trackingDevice.id)
            WHERE trackingAccessToken.id = ${ctx.params.id}
            FOR UPDATE
        `);

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const { timeFrom, timeTo, note, listingLabel } = ctx.request.body;

      await conn.query(SQL`
            UPDATE trackingAccessToken SET
              note = ${note},
              timeFrom = ${timeFrom && new Date(timeFrom)},
              timeTo = ${timeTo && new Date(timeTo)},
              listingLabel = ${listingLabel}
              WHERE id = ${ctx.params.id}
          `);

      ctx.status = 204;
    },
  );
};
