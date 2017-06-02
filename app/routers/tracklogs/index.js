const express = require('express');

const attachCreateTracklogHandler = rootRequire('routers/tracklogs/createTracklogHandler');
const attachGetTracklogHandler = rootRequire('routers/tracklogs/getTracklogHandler');

const router = express.Router();

attachCreateTracklogHandler(router);
attachGetTracklogHandler(router);

module.exports = router;
