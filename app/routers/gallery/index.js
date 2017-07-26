const express = require('express');

const attachGetPicturesInRadiusHandler = require('~/routers/gallery/getPicturesInRadiusHandler');
const attachGetPictureHandler = require('~/routers/gallery/getPictureHandler');

const router = express.Router();

attachGetPicturesInRadiusHandler(router);
attachGetPictureHandler(router);

module.exports = router;
