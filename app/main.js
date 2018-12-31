const config = require('config');
const koaBody = require('koa-body');
const Koa = require('koa');
const Router = require('koa-router');
const cors = require('kcors');
const koaBunyanLogger = require('koa-bunyan-logger');

const logger = require('~/logger');
const { initDatabase } = require('~/database');

const tracklogsRouter = require('~/routers/tracklogs');
const galleryRouter = require('~/routers/gallery');
const authRouter = require('~/routers/auth');
const geotoolsRouter = require('~/routers/geotools');

const attachLoggerHandler = require('~/routers/loggerHandler');

const fs = require('fs');

const app = new Koa();

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

const router = new Router();
router.use('/tracklogs', tracklogsRouter.routes(), tracklogsRouter.allowedMethods());
router.use('/gallery', galleryRouter.routes(), galleryRouter.allowedMethods());
router.use('/auth', authRouter.routes(), authRouter.allowedMethods());
router.use('/geotools', geotoolsRouter.routes(), geotoolsRouter.allowedMethods());
attachLoggerHandler(router);

app.use(router.routes());

initDatabase()
  .then(() => {
    /* eslint-disable global-require */
    const port = config.get('http.port');
    const ssl = config.get('http.ssl');

    const server = ssl
      ? require('https').createServer(
        {
          key: fs.readFileSync('ssl/freemap.sk.key'),
          cert: fs.readFileSync('ssl/freemap.sk.pem'),
        },
        app.callback(),
      )
      : require('http').createServer(app.callback());

    server.listen(port, () => {
      logger.info(`Freemap v3 API listening on port ${port}.`);
    });
  }).catch((err) => {
    logger.fatal({ err }, 'Error initializing database.');
  });
