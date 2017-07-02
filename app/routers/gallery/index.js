const express = require('express');

const attachGetPicturesInRadiusHandler = rootRequire('routers/gallery/getPicturesInRadiusHandler');
const attachGetPictureHandler = rootRequire('routers/gallery/getPictureHandler');

const router = express.Router();

attachGetPicturesInRadiusHandler(router);
attachGetPictureHandler(router);

module.exports = router;
