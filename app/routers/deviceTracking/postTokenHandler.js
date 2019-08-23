const randomize = require('randomatic');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const postTokenSchema = require('./postTokenSchema');

module.exports = router => {
  router.post(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    bodySchemaValidator(postTokenSchema, true),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const [device] = await ctx.state.db.query(
        'SELECT userId FROM trackingDevice WHERE id = ?',
        [ctx.params.id]
      );

      if (!device) {
        ctx.state = 404;
      } else if (
        !ctx.state.user.isAdmin &&
        ctx.state.user.id !== device.userId
      ) {
        ctx.status = 403;
      } else {
        const token = randomize('Aa0', 8);
        const { timeFrom, timeTo, note, listingLabel } = ctx.request.body;

        const { insertId } = await ctx.state.db.query(
          'INSERT INTO trackingAccessToken (deviceId, token, timeFrom, timeTo, note, listingLabel) VALUES (?, ?, ?, ?, ?, ?)',
          [
            ctx.params.id,
            token,
            timeFrom && new Date(timeFrom),
            timeTo && new Date(timeTo),
            note,
            listingLabel
          ]
        );

        ctx.body = { id: insertId, token };
      }
    }
  );
};
