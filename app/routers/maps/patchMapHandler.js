const SQL = require('sql-template-strings');
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
      const id = Number(ctx.params.id);

      const [item] = await ctx.state.db.query(
        SQL`SELECT userId FROM map WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const { name, public, data } = ctx.request.body;

      const parts = [];

      if (name !== undefined) {
        parts.push(SQL`name = ${name}`);
      }

      if (public !== undefined) {
        parts.push(SQL`public = ${public}`);
      }

      if (data !== undefined) {
        parts.push(SQL`data = ${JSON.stringify(data)}`);
      }

      const query = SQL`UPDATE map SET`;

      for (let i = 0; i < parts.length; i++) {
        query.append(i ? ',' : ' ').append(parts[i]);
      }

      await ctx.state.db.query(query.append(SQL`WHERE id = ${id}`));

      ctx.status = 204;
    },
  );
};
