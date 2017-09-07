const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');


module.exports = function attachGetAllTagsHandler(router) {
  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      ctx.body = await ctx.state.db.query('SELECT name, count(*) AS count FROM pictureTag GROUP BY name ORDER BY name');
    },
  );
};
