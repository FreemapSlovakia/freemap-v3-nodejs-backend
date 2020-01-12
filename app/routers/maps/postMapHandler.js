const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const postMapSchema = require('./postMapSchema');

module.exports = router => {
  router.post(
    '/',
    acceptValidator('application/json'),
    bodySchemaValidator(postMapSchema, true),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const { name, public, data } = ctx.request.body;

      const {
        insertId,
      } = await ctx.state.db.query(
        'INSERT INTO map (name, public, userId, data) VALUES (?, ?, ?, ?)',
        [name, public, ctx.state.user.id, JSON.stringify(data)],
      );

      ctx.body = { id: insertId };
    },
  );
};
