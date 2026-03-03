import Router from '@koa/router';
import { attachCoveredCountriesHandler } from './coveredCountries.js';
import { attachElevationHandler } from './elevation.js';

const router = new Router();

attachElevationHandler(router);

attachCoveredCountriesHandler(router);

export const geotoolsRouter = router;
