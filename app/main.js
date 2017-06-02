const express = require('express');
const config = require('config');
const bodyParser = require('body-parser');

const logger = rootRequire('logger');
const originAccessControlMiddleware = rootRequire('originAccessControlMiddleware');
const httpLoggerMiddleware = rootRequire('httpLoggerMiddleware');

const tracklogsRouter = rootRequire('routers/tracklogs');

const app = express();

app.use(httpLoggerMiddleware);

app.use(originAccessControlMiddleware);

app.use(bodyParser.json({ limit: '5mb' }));

app.use('/tracklogs', tracklogsRouter);

const port = config.get('http.port');
app.listen(port, () => {
  logger.info(`Freemap v3 API listening on port ${port}.`);
});
