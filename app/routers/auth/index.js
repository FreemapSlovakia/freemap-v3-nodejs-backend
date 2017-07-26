const express = require('express');

const attachLoginHandler = require('~/routers/auth/loginHandler');
const attachLogin2Handler = require('~/routers/auth/login2Handler');

const router = express.Router();

attachLoginHandler(router);
attachLogin2Handler(router);

module.exports = router;
