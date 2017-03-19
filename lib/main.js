const express = require('express');
const app = express();
const bunyan = require('bunyan');
const config = require('config');

const port = config.get('http.port');

const logger = bunyan.createLogger({ name: 'gruveo-server' });

app.get('/', function (req, res) {
  res.send('Hello World!');
});

app.listen(port, function () {
  logger.info(`Freemap v3 API on port ${port}.`);
});
