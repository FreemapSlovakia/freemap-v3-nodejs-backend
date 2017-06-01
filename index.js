global.rootDir = __dirname;
global.rootRequire = name => require(`${__dirname}/app/${name}`);

require('./app/main.js');
