import { promises as fs, readFileSync } from 'fs';
import config from 'config';
import koaBody from 'koa-body';
import Koa from 'koa';
import Router from '@koa/router';
import cors from 'kcors';
import koaBunyanLogger from 'koa-bunyan-logger';
import websockify from 'koa-websocket';

import { appLogger } from './logger';
import { initDatabase } from './database';
import { attachWs } from './ws';

import { tracklogsRouter } from './routers/tracklogs';
import { galleryRouter } from './routers/gallery';
import { mapsRouter } from './routers/maps';
import { authRouter } from './routers/auth';
import { geotoolsRouter } from './routers/geotools';
import { trackingRouter } from './routers/deviceTracking';
import { attachLoggerHandler } from './routers/loggerHandler';

const logger = appLogger.child({ module: 'app' });

const ssl = config.get('http.ssl') as any;

const app = websockify(
  new Koa(),
  {},
  ssl
    ? {
        key: readFileSync(ssl.key),
        cert: readFileSync(ssl.cert),
      }
    : undefined,
);

app.use(koaBunyanLogger(appLogger.child({ module: 'koa' })));

app.use(koaBunyanLogger.requestIdContext());

app.use(koaBunyanLogger.requestLogger());

app.use(
  cors({
    origin: ctx =>
      /\.freemap\.sk(:\d+)?$/.test(ctx.header.origin)
        ? ctx.header.origin
        : null,
  }),
);

app.use(
  koaBody({
    jsonLimit: '16mb',
    multipart: true,
  }),
);

// remove tmp uploaded files
app.use(async (ctx, next) => {
  await next();

  if (ctx.request.files) {
    const proms = [];

    for (const field of Object.keys(ctx.request.files)) {
      const files = ctx.request.files[field];

      for (const file of Array.isArray(files) ? files : [files]) {
        proms.push(fs.unlink(file.path));
      }
    }
    await Promise.all(proms);
  }
});

const router = new Router();

router.use(
  '/tracklogs',
  tracklogsRouter.routes(),
  tracklogsRouter.allowedMethods(),
);

router.use('/gallery', galleryRouter.routes(), galleryRouter.allowedMethods());

router.use('/auth', authRouter.routes(), authRouter.allowedMethods());

router.use(
  '/geotools',
  geotoolsRouter.routes(),
  geotoolsRouter.allowedMethods(),
);

router.use(
  '/tracking',
  trackingRouter.routes(),
  trackingRouter.allowedMethods(),
);

router.use('/maps', mapsRouter.routes(), mapsRouter.allowedMethods());

attachLoggerHandler(router);

app.use(router.routes()).use(router.allowedMethods());

attachWs(app);

initDatabase()
  .then(() => {
    /* eslint-disable global-require */
    const port = config.get('http.port');

    app.listen(port, () => {
      logger.info(`Freemap v3 API listening on port ${port}.`);
    });
  })
  .catch(err => {
    logger.fatal({ err }, 'Error initializing database.');
  });
