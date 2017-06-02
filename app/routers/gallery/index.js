const express = require('express');

const attachGetPicturesInRadiusHandler = rootRequire('routers/gallery/getPicturesInRadiusHandler');

const router = express.Router();

attachGetPicturesInRadiusHandler(router);

module.exports = router;
