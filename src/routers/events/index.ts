import Router from '@koa/router';
import { attachDeleteEventHandler } from './deleteEventHandler.js';
import { attachGetEventHandler } from './getEventHandler.js';
import { attachGetEventsHandler } from './getEventsHandler.js';
import { attachPatchEventHandler } from './patchEventHandler.js';
import { attachPostEventHandler } from './postEventHandler.js';

const router = new Router();

attachGetEventsHandler(router);
attachPostEventHandler(router);
attachGetEventHandler(router);
attachPatchEventHandler(router);
attachDeleteEventHandler(router);

export const eventsRouter = router;
