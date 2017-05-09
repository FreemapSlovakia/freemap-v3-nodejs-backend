global.rootRequire = function (name) {
  return require(__dirname + '/lib/' + name);
};

require('./app/main.js');
