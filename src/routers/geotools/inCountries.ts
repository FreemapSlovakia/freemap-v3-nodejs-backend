import { ParameterizedContext } from 'koa';
import { Piscina } from 'piscina';
import { getEnv } from '../../env.js';

const countriesDb = getEnv('COUNTRIES_DB', '');

const piscina = countriesDb
  ? new Piscina({
      filename: new URL('./inCountriesWorker.js', import.meta.url).href,
      maxThreads: 4,
      minThreads: 1,
    })
  : undefined;

export async function inCountries(ctx: ParameterizedContext) {
  if (piscina) {
    ctx.body = await piscina.run(ctx.request.body);
  } else {
    ctx.response.status = 404;
  }
}

// POST http://localhost:3001/geotools/in-count
// Content-Type: text/plain
//
// POLYGON((2365373 6245707, 2507880 6245707, 2507880 6144612, 2365373 6144612, 2365373 6245707))
