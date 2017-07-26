const express = require('express');
const config = require('config');
const bodyParser = require('body-parser');

const logger = require('~/logger');
const originAccessControlMiddleware = require('~/originAccessControlMiddleware');
const httpLoggerMiddleware = require('~/httpLoggerMiddleware');
const { initDatabase } = require('~/database');

const tracklogsRouter = require('~/routers/tracklogs');
const galleryRouter = require('~/routers/gallery');
const authRouter = require('~/routers/auth');

const app = express();

app.use(httpLoggerMiddleware);

app.use(originAccessControlMiddleware);

app.use(bodyParser.json({ limit: '5mb' }));

app.use('/tracklogs', tracklogsRouter);
app.use('/gallery', galleryRouter);
app.use('/auth', authRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'no_such_handler' });
});

initDatabase((err) => {
  if (err) {
    logger.fatal({ err }, 'Error initializing database.');
  } else {
    const port = config.get('http.port');
    app.listen(port, () => {
      logger.info(`Freemap v3 API listening on port ${port}.`);
    });
  }
});
