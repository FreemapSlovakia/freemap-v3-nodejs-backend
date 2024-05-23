import 'source-map-support/register.js';
import { promises as fs, readFileSync } from 'fs';
import koaBody from 'koa-body';
import Koa from 'koa';
import Router from '@koa/router';
import cors from 'kcors';
import koaBunyanLogger from 'koa-bunyan-logger';
import websockify from 'koa-websocket';
import { appLogger } from './logger.js';
import { initDatabase } from './database.js';
import { attachWs } from './ws.js';
import { tracklogsRouter } from './routers/tracklogs/index.js';
import { galleryRouter } from './routers/gallery/index.js';
import { mapsRouter } from './routers/maps/index.js';
import { authRouter } from './routers/auth/index.js';
import { geotoolsRouter } from './routers/geotools/index.js';
import { trackingRouter } from './routers/deviceTracking/index.js';
import { attachLoggerHandler } from './routers/loggerHandler.js';
import { getEnv } from './env.js';
import { startSocketDeviceTracking } from './socketDeviceTracking.js';
import { attachGetUsers } from './routers/getUsersHandler.js';

const logger = appLogger.child({ module: 'app' });

const app = websockify(
  new Koa(),
  {},
  getEnv('HTTP_SSL_ENABLE', '')
    ? {
        key: readFileSync(getEnv('HTTP_SSL_KEY')),
        cert: readFileSync(getEnv('HTTP_SSL_CERT')),
      }
    : undefined,
);

app.use(koaBunyanLogger(appLogger.child({ module: 'koa' })));

app.use(koaBunyanLogger.requestIdContext());

app.use(
  koaBunyanLogger.requestLogger({
    updateRequestLogFields(rd): any {
      return {
        method: rd.req.method,
        url: rd.req.url,
        userAgent: rd.req.headers['user-agent'],
      };
    },
    updateResponseLogFields(rd: any): any {
      return {
        err: rd.err,
        // status: (rd.res as any).statusCode,
        duration: rd.duration,
      };
    },
  }),
);

app.use(
  cors({
    origin: (ctx) =>
      /\.freemap\.sk(:\d+)?$/.test(ctx.header.origin)
        ? ctx.header.origin
        : null,
  }),
);

app.use(
  koaBody.default({
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
        proms.push(fs.unlink(file.filepath));
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

attachGetUsers(router);

app.use(router.routes()).use(router.allowedMethods());

attachWs(app);

initDatabase()
  .then(() => {
    const port = getEnv('HTTP_PORT');

    app.listen(port, () => {
      logger.info(`Freemap v3 API listening on port ${port}.`);
    });

    startSocketDeviceTracking();
  })
  .catch((err) => {
    logger.fatal({ err }, 'Error initializing database.');
  });
