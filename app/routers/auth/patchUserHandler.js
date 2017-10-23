const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');
const patchUserSchema = require('./patchUserSchema');
const { bodySchemaValidator } = require('~/requestValidators');

module.exports = function attachPatchUserHandler(router) {
  router.patch(
    '/settings',
    authenticator(true, false),
    bodySchemaValidator(patchUserSchema),
    dbMiddleware,
    async (ctx) => {
      const keys = Object.keys(ctx.request.body);

      // TODO validate duplicates

      await ctx.state.db.query(
        `UPDATE user SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(key => ctx.request.body[key]), ctx.state.user.id],
      );
    },
  );
};
