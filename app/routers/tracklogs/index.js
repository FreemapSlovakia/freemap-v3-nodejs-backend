const Router = require('koa-router');

const attachCreateTracklogHandler = require('~/routers/tracklogs/createTracklogHandler');
const attachGetTracklogHandler = require('~/routers/tracklogs/getTracklogHandler');

const router = new Router();

attachCreateTracklogHandler(router);
attachGetTracklogHandler(router);

module.exports = router;
