const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const patchMapSchema = require('./patchMapSchema');

module.exports = router => {
  router.patch(
    '/:id',
    acceptValidator('application/json'),
    bodySchemaValidator(patchMapSchema, true),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const [
        item,
      ] = await ctx.state.db.query(
        'SELECT userId FROM map WHERE id = ? FOR UPDATE',
        [ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        const { name, public, data } = ctx.request.body;

        const fields = [];
        const values = [];

        if (name !== undefined) {
          fields.push('name');
          values.push(name);
        }

        if (public !== undefined) {
          fields.push('public');
          values.push(public);
        }

        if (data !== undefined) {
          fields.push('data');
          values.push(JSON.stringify(data));
        }

        await ctx.state.db.query(
          `UPDATE map SET ${fields
            .map(f => `${f} = ?`)
            .join(',')} WHERE id = ?`,
          [...values, ctx.params.id],
        );

        ctx.status = 204;
      }
    },
  );
};
