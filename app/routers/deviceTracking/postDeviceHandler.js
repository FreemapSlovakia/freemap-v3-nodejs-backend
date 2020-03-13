const SQL = require('sql-template-strings');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const randomize = require('randomatic');
const { bodySchemaValidator } = require('~/requestValidators');
const postDeviceSchema = require('./postDeviceSchema');

module.exports = router => {
  router.post(
    '/devices',
    acceptValidator('application/json'),
    bodySchemaValidator(postDeviceSchema, true),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const token = randomize('Aa0', 8);

      const { name, maxCount, maxAge } = ctx.request.body;

      const { insertId } = await ctx.state.db.query(SQL`
        INSERT INTO trackingDevice SET
          name = ${name},
          token = ${token},
          userId = ${ctx.state.user.id},
          maxCount = ${maxCount},
          maxAge = ${maxAge}
      `);

      ctx.body = { id: insertId, token };
    },
  );
};
