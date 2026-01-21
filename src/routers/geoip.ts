// 'x-geoip-country': 'Slovakia',
// 'x-geoip-country-code': 'SK',
// 'x-geoip-city': 'Nitra',
// 'x-geoip-latitude': '48.30970',
// 'x-geoip-longitude': '18.09050',

import { RouterInstance } from '@koa/router';
import { acceptValidator } from '../requestValidators.js';

export function attachGeoIp(router: RouterInstance) {
  router.get('/geoip', acceptValidator('application/json'), async (ctx) => {
    const body: Record<string, string | undefined> = {};

    for (const name in [
      'country',
      'country-code',
      'city',
      'latitude',
      'longitude',
    ]) {
      const value = ctx.req.headers['x-geoip-' + name];

      if (typeof value === 'string') {
        body[name === 'country-code' ? 'countryCode' : name] = value;
      }
    }

    ctx.body = body;
  });
}
