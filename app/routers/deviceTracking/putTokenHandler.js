const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const putTokenSchema = require('./putTokenSchema');

module.exports = router => {
  router.put(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    bodySchemaValidator(putTokenSchema, true),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const [item] = await ctx.state.db.query(
        `SELECT userId
          FROM trackingAccessToken
          JOIN trackingDevice ON (deviceId = trackingDevice.id)
          WHERE trackingAccessToken.id = ?
          FOR UPDATE`,
        [ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        const { timeFrom, timeTo, note, listingLabel } = ctx.request.body;

        await ctx.state.db.query(
          `UPDATE trackingAccessToken
            SET note = ?, timeFrom = ?, timeTo = ?, listingLabel = ?
            WHERE id = ?`,
          [
            note,
            timeFrom && new Date(timeFrom),
            timeTo && new Date(timeTo),
            listingLabel,
            ctx.params.id,
          ],
        );

        ctx.status = 204;
      }
    },
  );
};
