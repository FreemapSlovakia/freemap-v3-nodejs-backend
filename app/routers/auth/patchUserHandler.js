const { pool } = require('~/database');
const authenticator = require('~/authenticator');
const patchUserSchema = require('./patchUserSchema');
const { bodySchemaValidator } = require('~/requestValidators');

module.exports = function attachPatchUserHandler(router) {
  router.patch(
    '/settings',
    authenticator(true, false),
    bodySchemaValidator(patchUserSchema),
    async ctx => {
      const { body } = ctx.request;

      const keys = Object.keys(body);

      // TODO validate duplicates

      await pool.query(
        `UPDATE user SET ${keys
          .map(key => `${key} = ?`)
          .join(', ')} WHERE id = ?`,
        [
          ...keys.map(key =>
            key === 'settings' ? JSON.stringify(body[key]) : body[key],
          ),
          ctx.state.user.id,
        ],
      );

      ctx.status = 204;
    },
  );
};
