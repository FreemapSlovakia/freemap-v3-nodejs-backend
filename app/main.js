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

const app = new Koa();

app.use(koaBunyanLogger());
app.use(koaBunyanLogger.requestIdContext());
app.use(koaBunyanLogger.requestLogger());

app.use(cors({
  origin: ctx => (/\.freemap\.sk(:\d+)?$/.test(ctx.header.origin) ? ctx.header.origin : null),
}));

app.use(koaBody({
  jsonLimit: '5mb',
  multipart: true,
}));

const router = new Router();
router.use('/tracklogs', tracklogsRouter.routes(), tracklogsRouter.allowedMethods());
router.use('/gallery', galleryRouter.routes(), galleryRouter.allowedMethods());
router.use('/auth', authRouter.routes(), authRouter.allowedMethods());

app.use(router.routes());

initDatabase()
  .then(() => {
    const port = config.get('http.port');
    app.listen(port, () => {
      logger.info(`Freemap v3 API listening on port ${port}.`);
    });
  }).catch((err) => {
    logger.fatal({ err }, 'Error initializing database.');
  });
