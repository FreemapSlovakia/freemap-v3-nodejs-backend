const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const { bodySchemaValidator } = require('~/requestValidators');
const postMapSchema = require('./postMapSchema');

module.exports = router => {
  router.post(
    '/',
    acceptValidator('application/json'),
    bodySchemaValidator(postMapSchema, true),
    authenticator(true),
    async ctx => {
      const { name, public, data } = ctx.request.body;

      const { insertId } = await pool.query(SQL`
        INSERT INTO map SET
          name = ${name},
          public = ${public},
          userId = ${ctx.state.user.id},
          data = ${JSON.stringify(data)}
      `);

      ctx.body = { id: insertId };
    },
  );
};
