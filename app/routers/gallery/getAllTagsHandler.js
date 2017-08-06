const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');


module.exports = function attachGetAllTagsHandler(router) {
  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      const rows = await ctx.state.db.query('SELECT DISTINCT name FROM pictureTag ORDER BY name');
      ctx.body = rows.map(row => row.name);
    },
  );
};
