const express = require('express');
const bunyan = require('bunyan');
const config = require('config');
const bodyParser = require('body-parser');
const jsonParser = bodyParser.json({limit: '5mb'});
const uuidBase62 = require('uuid-base62');
const fs = require('fs');
const port = config.get('http.port');
const logger = bunyan.createLogger({ name: 'freemap-api' });
const app = express();
const USER_DATA_DIR = './user_data';

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.get('/', function (req, res) {
  res.send('Hello World!');
});

app.get('/tracklogs/:uid', function (req, res) {
  const fileUID = req.params.uid;
  if (!fileUID.match(/^[a-zA-Z0-9]*$/)) {
    res.status(400).json({ error: 'bad uid' });
  } else {
    const filePath = USER_DATA_DIR + '/tracklogs/' + fileUID + '.b64.gpx';
    fs.readFile(filePath, 'utf8', function read(err,  b64gpx) {
      if (err) {
        logger.error({ err }, `Failed to save gpx file to "${filePath}".`);
        res.status(404).json({ error: 'file with such uid not found' });
      } else {
        res.status(200).json({ uid: fileUID, data: b64gpx, mediaType: 'application/gpx+xml' });
      }
    });
  }
});

app.post('/tracklogs', jsonParser, function (req, res) {
  const b64gpx = req.body.data;
  if (b64gpx && b64gpx.length) {
    const fileUID = uuidBase62.v4();
    const filePath = USER_DATA_DIR + '/tracklogs/' + fileUID + '.b64.gpx';
    fs.writeFile(filePath, b64gpx, (err) => {
      if (err) {
        logger.error({ err }, `Failed to save gpx file to "${filePath}".`);
        res.status(500).json({ error: err });
      } else {
        res.status(201).json({ uid: fileUID });
      }
    });
  } else {
    res.status(400).send({ error: 'no data found in request' });
  }

});

app.listen(port, function () {
  logger.info(`Freemap v3 API on port ${port}.`);
});