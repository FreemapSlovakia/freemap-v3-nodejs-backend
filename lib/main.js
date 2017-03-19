const express = require('express');
const bunyan = require('bunyan');
const config = require('config');

const port = config.get('http.port');

const logger = bunyan.createLogger({ name: 'freemap-api' });

const app = express();

app.get('/', function (req, res) {
  res.send('Hello World!');
});

app.listen(port, function () {
  logger.info(`Freemap v3 API on port ${port}.`);
});
