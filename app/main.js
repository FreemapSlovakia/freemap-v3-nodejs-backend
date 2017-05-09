const express = require('express');
const bunyan = require('bunyan');
const config = require('config');
const bodyParser = require('body-parser')
const jsonParser = bodyParser.json({limit: '5mb'})
const uuidBase62 = require('uuid-base62');
const fs = require('fs');
const port = config.get('http.port');
const logger = bunyan.createLogger({ name: 'freemap-api' });
const app = express();

const USER_DATA_DIR = './user_data'

app.get('/', function (req, res) {
  res.send('Hello World!');
});

app.post('/tracklogs', jsonParser, function (req, res) {
  const gpx = req.body.data;
  if(gpx && gpx.length) {
    const fileUID = uuidBase62.v4();
    const filePath = USER_DATA_DIR + '/tracklogs/' + fileUID + '.gpx';
    fs.writeFile(filePath, gpx, (err) => {
      if(err) {
        logger.error('failed to save gpx file to '+filePath)
        logger.error(err)
        res.status(500).send({error: err})
      } else {
        res.status(201).send({uid: fileUID});
      }
    })
  } else {
    res.status(400).send({error: 'no data found in request'});
  }

});

app.listen(port, function () {
  logger.info(`Freemap v3 API on port ${port}.`);
});