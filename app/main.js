const express = require('express');
const config = require('config');
const bodyParser = require('body-parser');

const logger = rootRequire('logger');
const attachTracklogsHandlers = rootRequire('handlers/tracklogs');

const port = config.get('http.port');
const app = express();

app.use(bodyParser.json({ limit: '5mb' }));

app.use((req, res, next) => {
  const origin = req.get('Origin');

  res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Accept-Language');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS, PATCH');
    res.status(204).end();
  } else {
    next();
  }
});

attachTracklogsHandlers(app);

app.listen(port, () => {
  logger.info(`Freemap v3 API listening on port ${port}.`);
});
