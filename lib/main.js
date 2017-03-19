const express = require('express');
const app = express();
const bunyan = require('bunyan');

const logger = bunyan.createLogger({ name: 'gruveo-server' });

app.get('/', function (req, res) {
  res.send('Hello World!');
});

app.listen(3000, function () {
  logger.info('Example app listening on port 3000!');
});
