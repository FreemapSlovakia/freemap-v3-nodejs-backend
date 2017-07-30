const Ajv = require('ajv');

const ajv = new Ajv();

module.exports = {
  queryValidator,
  bodySchemaValidator,
  acceptValidator,
  contentTypeValidator,
  queryAdapter,
};

function queryValidator(spec) {
  return async (ctx, next) => {
    const errors = [];
    Object.keys(spec).forEach((key) => {
      const msg = spec[key](ctx.query[key]);
      if (msg && typeof msg === 'string') {
        errors.push(key in ctx.query ? `invalid parameter ${key}: ${msg}` : `missing parameter ${key}`);
      }
    });

    if (errors.length) {
      ctx.status = 400;
      ctx.body = {
        error: 'invalid_query_parameters',
        detail: errors,
      };
    } else {
      await next();
    }
  };
}

function bodySchemaValidator(schema) {
  const validate = ajv.compile(schema);

  return async (ctx, next) => {
    if (!ctx.is('application/json')) {
      ctx.status = 415;
    } else if (!validate.validate(schema, ctx.request.body)) {
      ctx.status = 400;
      ctx.body = {
        error: 'request_body_doesnt_match_schema',
        detail: validate.errors,
      };
    } else {
      await next();
    }
  };
}

function acceptValidator(type) {
  return async (ctx, next) => {
    if (ctx.accepts(type)) {
      await next();
    } else {
      ctx.status = 406;
    }
  };
}

function contentTypeValidator(type) {
  return async (ctx, next) => {
    if (ctx.is(type)) {
      await next();
    } else {
      ctx.status = 415;
    }
  };
}

function queryAdapter(spec) {
  return async (ctx, next) => {
    Object.keys(spec).forEach((key) => {
      if (key in ctx.query) {
        ctx.query[key] = spec[key](ctx.query[key]);
      }
    });
    await next();
  };
}
