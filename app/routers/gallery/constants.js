const path = require('path');
const config = require('config');

const picturesDir = config.get('dir.pictures');

module.exports = {
  PICTURES_DIR: path.resolve(global.rootDir, picturesDir)
};
