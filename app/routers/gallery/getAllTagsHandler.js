const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = function attachGetAllTagsHandler(router) {
  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    async ctx => {
      ctx.body = await pool.query(
        'SELECT name, count(*) AS count FROM pictureTag GROUP BY name ORDER BY name',
      );
    },
  );
};
