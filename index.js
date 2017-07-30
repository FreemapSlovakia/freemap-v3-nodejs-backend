const Module = require('module');

global.rootDir = __dirname;

const originalRequire = Module.prototype.require;

Module.prototype.require = function require(id) {
  return originalRequire.call(this, id.startsWith('~/') ? `${__dirname}/app/${id.substring(2)}` : id);
};

require('./app/main.js');
