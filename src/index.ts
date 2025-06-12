import Router from '@koa/router';
import cors from 'kcors';
import Koa from 'koa';
import koaBody from 'koa-body';
import koaPinoLogger from 'koa-pino-logger';
import websockify from 'koa-websocket';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import 'source-map-support/register.js';
import { initDatabase } from './database.js';
import { getEnv, getEnvBoolean } from './env.js';
import { appLogger } from './logger.js';
import { authRouter } from './routers/auth/index.js';
import { trackingRouter } from './routers/deviceTracking/index.js';
import { galleryRouter } from './routers/gallery/index.js';
import { attachPostGarminCourses } from './routers/garminCoursesHandler.js';
import { geotoolsRouter } from './routers/geotools/index.js';
import { attachGetUsers } from './routers/getUsersHandler.js';
import { attachLoggerHandler } from './routers/loggerHandler.js';
import { mapsRouter } from './routers/maps/index.js';
import { tracklogsRouter } from './routers/tracklogs/index.js';
import { startSocketDeviceTracking } from './socketDeviceTracking.js';
import { attachWs } from './ws.js';

const logger = appLogger.child({ module: 'app' });

const app = websockify(
  new Koa(),
  {},
  getEnvBoolean('HTTP_SSL_ENABLE', false)
    ? {
        key: readFileSync(getEnv('HTTP_SSL_KEY')),
        cert: readFileSync(getEnv('HTTP_SSL_CERT')),
      }
    : undefined,
);

app.use(
  koaPinoLogger({
    base: { module: 'koa' },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          userAgent: req.headers['user-agent'],
        };
      },
      res(res) {
        return {
          id: res.id,
          statusCode: res.statusCode,
        };
      },
      err(err) {
        return {
          id: err.id,
          type: err.type,
          message: err.message,
          stack: err.stack,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin: (ctx) =>
      !ctx.header.origin
        ? ''
        : /\.freemap\.sk(:\d+)?$/.test(ctx.header.origin)
          ? ctx.header.origin!
          : '',
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
        proms.push(unlink(file.filepath));
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

attachPostGarminCourses(router);

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
