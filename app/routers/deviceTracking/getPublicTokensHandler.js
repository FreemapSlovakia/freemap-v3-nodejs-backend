const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = router => {
  router.get(
    '/access-tokens',
    acceptValidator('application/json'),
    async ctx => {
      ctx.body = await pool.query(
        `SELECT id, token, createdAt, timeFrom, timeTo, listingLabel
          FROM trackingAccessToken
          WHERE listingLabel IS NOT NULL`,
      );
    },
  );
};
