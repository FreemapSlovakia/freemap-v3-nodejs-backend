// 'x-geoip-country': 'Slovakia',
// 'x-geoip-country-code': 'SK',
// 'x-geoip-city': 'Nitra',
// 'x-geoip-latitude': '48.30970',
// 'x-geoip-longitude': '18.09050',

import { RouterInstance } from '@koa/router';
import z from 'zod';
import { registerPath } from '../openapi.js';
import { acceptValidator } from '../requestValidators.js';

const ResponseSchema = z.strictObject({
  country: z.string().optional(),
  countryCode: z.string().optional(),
  city: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
});

export function attachGeoIp(router: RouterInstance) {
  registerPath('/geoip', {
    get: {
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
      },
    },
  });

  router.get('/geoip', acceptValidator('application/json'), async (ctx) => {
    const body: Record<string, string | undefined> = {};

    for (const name of [
      'country',
      'country-code',
      'city',
      'latitude',
      'longitude',
    ]) {
      const value = ctx.req.headers['x-geoip-' + name];

      if (typeof value === 'string') {
        body[name === 'country-code' ? 'countryCode' : name] = Buffer.from(
          value,
          'latin1',
        ).toString('utf8');
      }
    }

    ctx.body = ResponseSchema.parse(body);
  });
}
