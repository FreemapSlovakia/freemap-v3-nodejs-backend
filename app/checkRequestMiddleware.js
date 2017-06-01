const Ajv = require('ajv');

const ajv = new Ajv();

module.exports = function checkRequestMiddleware({ method, acceptsJson, schema }) {
  return (req, res, next) => {
    if (method && req.method !== method) {
      res.status(405).header('Allow', method).end();
    } else if (acceptsJson && !req.accepts('application/json')) {
      res.status(406).end();
    } else if (schema) {
      if (!req.is('application/json')) {
        res.status(415).end();
      } else if (!ajv.validate(schema, req.body)) {
        res.status(400).json({ error: 'request_body_doesnt_match_schema', details: ajv.errorsText() });
      } else {
        next();
      }
    } else {
      next();
    }
  };
};
