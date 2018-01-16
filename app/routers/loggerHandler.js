const loggerSchema = require('~/routers/loggerSchema.json');
const { bodySchemaValidator } = require('~/requestValidators');

module.exports = function attachCreateTracklogHandler(router) {
  router.post(
    '/logger',
    bodySchemaValidator(loggerSchema),
    async (ctx) => {
      const { level, message, details = {} } = ctx.request.body;
      ctx.log[level](Object.assign({ subModule: 'client' }, details), message);

      ctx.body = { id: ctx.reqId };
    },
  );
};
