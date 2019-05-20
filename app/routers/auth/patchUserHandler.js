const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');
const patchUserSchema = require('./patchUserSchema');
const { bodySchemaValidator } = require('~/requestValidators');

module.exports = function attachPatchUserHandler(router) {
  router.patch(
    '/settings',
    dbMiddleware(),
    authenticator(true, false),
    bodySchemaValidator(patchUserSchema),
    dbMiddleware(),
    async (ctx) => {
      const keys = Object.keys(ctx.request.body);

      // TODO validate duplicates

      await ctx.state.db.query(
        `UPDATE user SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(key => (key === 'settings' ? JSON.stringify(ctx.request.body[key]) : ctx.request.body[key])), ctx.state.user.id],
      );

      ctx.status = 204;
    },
  );
};
