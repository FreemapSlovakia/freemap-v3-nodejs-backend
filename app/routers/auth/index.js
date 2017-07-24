const express = require('express');

const attachLoginHandler = rootRequire('routers/auth/loginHandler');
const attachLogin2Handler = rootRequire('routers/auth/login2Handler');

const router = express.Router();

attachLoginHandler(router);
attachLogin2Handler(router);

module.exports = router;
