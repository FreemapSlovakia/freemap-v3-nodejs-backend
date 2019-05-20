const util = require('util');
const fs = require('fs');
const config = require('config');
const koaBody = require('koa-body');
const Koa = require('koa');
const Router = require('koa-router');
const cors = require('kcors');
const koaBunyanLogger = require('koa-bunyan-logger');
const websockify = require('koa-websocket');

const logger = require('~/logger');
const { initDatabase } = require('~/database');
const attachWs = require('~/ws');

const tracklogsRouter = require('~/routers/tracklogs');
const galleryRouter = require('~/routers/gallery');
const authRouter = require('~/routers/auth');
const geotoolsRouter = require('~/routers/geotools');
const trackingRouter = require('~/routers/deviceTracking');

const attachLoggerHandler = require('~/routers/loggerHandler');

const unlinkAsync = util.promisify(fs.unlink);

const ssl = config.get('http.ssl');

const app = websockify(new Koa(), {}, ssl ? {
  key: fs.readFileSync(ssl.key),
  cert: fs.readFileSync(ssl.cert),
} : undefined);

app.use(koaBunyanLogger(logger.child({ module: 'koa' })));
app.use(koaBunyanLogger.requestIdContext());
app.use(koaBunyanLogger.requestLogger());

app.use(cors({
  origin: ctx => (/\.freemap\.sk(:\d+)?$/.test(ctx.header.origin) ? ctx.header.origin : null),
}));

app.use(koaBody({
  jsonLimit: '16mb',
  multipart: true,
}));

// remove tmp uploaded files
app.use(async (ctx, next) => {
  await next();

  if (ctx.request.files) {
    const proms = [];
    for (const field of Object.keys(ctx.request.files)) {
      const files = ctx.request.files[field];
      for (const file of Array.isArray(files) ? files : [files]) {
        proms.push(unlinkAsync(file.path));
      }
    }
    await Promise.all(proms);
  }
});

const router = new Router();

router.use('/tracklogs', tracklogsRouter.routes(), tracklogsRouter.allowedMethods());
router.use('/gallery', galleryRouter.routes(), galleryRouter.allowedMethods());
router.use('/auth', authRouter.routes(), authRouter.allowedMethods());
router.use('/geotools', geotoolsRouter.routes(), geotoolsRouter.allowedMethods());
router.use('/tracking', trackingRouter.routes(), trackingRouter.allowedMethods());

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
  }).catch((err) => {
    logger.fatal({ err }, 'Error initializing database.');
  });
