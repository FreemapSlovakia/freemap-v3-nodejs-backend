const attachCreateTracklogHandler = rootRequire('handlers/tracklogs/createTracklogHandler');
const attachGetTracklogHandler = rootRequire('handlers/tracklogs/getTracklogHandler');

module.exports = function attachTracklogsHandlers(app) {
  attachCreateTracklogHandler(app);
  attachGetTracklogHandler(app);
};
