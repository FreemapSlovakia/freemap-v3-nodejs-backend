const express = require('express');

const attachCreateTracklogHandler = require('~/routers/tracklogs/createTracklogHandler');
const attachGetTracklogHandler = require('~/routers/tracklogs/getTracklogHandler');

const router = express.Router();

attachCreateTracklogHandler(router);
attachGetTracklogHandler(router);

module.exports = router;
