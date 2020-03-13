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
    Object.keys(spec).forEach(key => {
      const msg = spec[key](ctx.query[key], ctx);
      if (msg && typeof msg === 'string') {
        errors.push(
          key in ctx.query
            ? `invalid parameter ${key}: ${msg}`
            : `missing parameter ${key}`,
        );
      }
    });

    if (errors.length) {
      ctx.body = {
        error: 'invalid_query_parameters',
        detail: errors,
      };

      ctx.throw(400);
    }

    await next();
  };
}

function bodySchemaValidator(schema, ignoreType) {
  const validate = ajv.compile(schema);

  return async (ctx, next) => {
    if (!ignoreType && !ctx.is('application/json')) {
      ctx.throw(415);
    }

    if (!validate(ctx.request.body)) {
      ctx.body = {
        error: 'request_body_doesnt_match_schema',
        detail: validate.errors,
      };

      ctx.throw(400);
    }

    await next();
  };
}

function acceptValidator(type) {
  return async (ctx, next) => {
    if (!ctx.accepts(type)) {
      ctx.throw(406);
    }

    await next();
  };
}

function contentTypeValidator(type) {
  return async (ctx, next) => {
    if (!ctx.is(type)) {
      ctx.throw(415);
    }

    await next();
  };
}

function queryAdapter(spec) {
  return async (ctx, next) => {
    Object.keys(spec).forEach(key => {
      ctx.query[key] = spec[key](ctx.query[key]);
    });

    await next();
  };
}
