import { Middleware, ParameterizedContext } from 'koa';

import Ajv from 'ajv';
import { JSONSchema7 } from 'json-schema';

const ajv = new Ajv();

export type ValidationRules = {
  [name: string]: (v: any, ctx?: ParameterizedContext) => true | string;
};

export function queryValidator(spec: ValidationRules): Middleware {
  return async (ctx, next) => {
    const errors: string[] = [];
    Object.keys(spec).forEach((key) => {
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

      ctx.status = 400;
      return;
    }

    await next();
  };
}

export function bodySchemaValidator(
  schema: JSONSchema7,
  ignoreType?: boolean,
): Middleware {
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

      ctx.status = 400;
      return;
    }

    await next();
  };
}

export function acceptValidator(...type: string[]): Middleware {
  return async (ctx, next) => {
    if (!ctx.accepts(type)) {
      ctx.throw(406);
    }

    await next();
  };
}

export function contentTypeValidator(...type: string[]): Middleware {
  return async (ctx, next) => {
    if (!ctx.is(type)) {
      ctx.throw(415);
    }

    await next();
  };
}

export type AdapterRules = {
  [name: string]: (v: string) => any;
};

export function queryAdapter(spec: AdapterRules): Middleware {
  return async (ctx, next) => {
    for (const key of Object.keys(spec)) {
      const value = ctx.query[key];

      ctx.query[key] = spec[key](Array.isArray(value) ? value[0] : value);
    }

    await next();
  };
}
