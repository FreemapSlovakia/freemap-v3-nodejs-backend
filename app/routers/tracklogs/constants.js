const path = require('path');
const config = require('config');

const tracklogsDir = config.get('dir.tracklogs');

module.exports = {
  TRACKLOGS_DIR: path.resolve(global.rootDir, tracklogsDir),
};
