const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = router => {
  router.get(
    '/access-tokens',
    acceptValidator('application/json'),
    dbMiddleware(),
    async ctx => {
      ctx.body = await ctx.state.db.query(
        `SELECT id, token, createdAt, timeFrom, timeTo, listingLabel
          FROM trackingAccessToken
          WHERE listingLabel IS NOT NULL`,
      );
    },
  );
};
