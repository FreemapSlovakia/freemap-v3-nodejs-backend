import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import Router from '@koa/router';
import { createServer as createSecureServer } from 'https';
import cors from 'kcors';
import Koa from 'koa';
import koaBody from 'koa-body';
import koaPinoLogger from 'koa-pino-logger';
import websockify from 'koa-websocket';
import 'source-map-support/register.js';
import { createDocument } from 'zod-openapi';
import { initDatabase } from './database.js';
import { getEnv, getEnvInteger } from './env.js';
import { appLogger } from './logger.js';
import { paths } from './openapi.js';
import { authRouter } from './routers/auth/index.js';
import { trackingRouter } from './routers/deviceTracking/index.js';
import { attachDownloadMapHandler } from './routers/downloadMapHandler.js';
import { galleryRouter } from './routers/gallery/index.js';
import { attachPostGarminCourses } from './routers/garminCoursesHandler.js';
import { attachGeoIp } from './routers/geoip.js';
import { geotoolsRouter } from './routers/geotools/index.js';
import { attachGetUsers } from './routers/getUsersHandler.js';
import { attachLoggerHandler } from './routers/loggerHandler.js';
import { mapsRouter } from './routers/maps/index.js';
import { tracklogsRouter } from './routers/tracklogs/index.js';
import { startSocketDeviceTracking } from './socketDeviceTracking.js';
import { attachWs } from './ws.js';

await initDatabase();

const logger = appLogger.child({ module: 'app' });

const app = new Koa();

const wsApp = websockify(app);

const httpHostname = getEnv('HTTP_HOSTNAME', '127.0.0.1');

const httpPort = getEnvInteger('HTTP_PORT', 0);

if (httpPort) {
  const httpServer = createServer(wsApp.callback());

  wsApp.ws.listen({ server: httpServer });

  httpServer.listen(httpPort, httpHostname, () => {
    logger.info(`Freemap v3 HTTP API listening on port ${httpPort}.`);
  });
}

const httpsHostname = getEnv('HTTPS_HOSTNAME', '127.0.0.1');

const httpsPort = getEnvInteger('HTTPS_PORT', 0);

if (httpsPort) {
  const httpsOptions = {
    key: readFileSync(getEnv('HTTP_SSL_KEY')),
    cert: readFileSync(getEnv('HTTP_SSL_CERT')),
  };

  const httpsServer = createSecureServer(httpsOptions, wsApp.callback());

  wsApp.ws.listen({ server: httpsServer });

  httpsServer.listen(httpsPort, httpsHostname, () => {
    logger.info(`Freemap v3 HTTPS API listening on port ${httpsPort}.`);
  });
}

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
        : /\.freemap\.(sk|eu)(:\d+)?$/.test(ctx.header.origin)
          ? ctx.header.origin!
          : '',
  }),
);

app.use((ctx, next) => {
  if (ctx.request.header['content-type']?.startsWith('application/geo+json')) {
    ctx.request.header['content-type'] = 'application/json';
  }

  return next();
});

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
        proms.push(unlink(file.filepath));
      }
    }
    await Promise.all(proms);
  }
});

const router = new Router();

router.post('/traccar', (ctx) => {
  console.log(ctx.request.body);

  ctx.status = 200;
});

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

attachDownloadMapHandler(router);

attachLoggerHandler(router);

attachGetUsers(router);

attachGeoIp(router);

attachPostGarminCourses(router);

router.get('/documentation', (ctx) => {
  ctx.body = createDocument({
    openapi: '3.1.1',
    info: {
      title: 'Freemap.sk API',
      version: '0.1.0',
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    tags: [
      { name: 'auth', description: 'Authentication' },
      { name: 'tracking', description: 'Device location tracking' },
      { name: 'gallery', description: 'Picture gallery' },
      { name: 'maps', description: 'Map annotations' },
    ],
    paths,
  });
});

router.get('/scalar', (ctx) => {
  ctx.type = 'text/html';
  ctx.body = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>API Reference</title>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <script
          id="api-reference"
          data-url="/documentation"
          src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
      </body>
    </html>
  `;
});

app.use(router.routes()).use(router.allowedMethods());

attachWs(wsApp);

startSocketDeviceTracking();
