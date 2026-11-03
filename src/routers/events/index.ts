import Router from '@koa/router';
import { attachDeleteEventHandler } from './deleteEventHandler.js';
import { attachGetEventHandler } from './getEventHandler.js';
import { attachGetEventsHandler } from './getEventsHandler.js';
import { attachPutEventHandler } from './putEventHandler.js';

const router = new Router();

attachGetEventsHandler(router);
attachGetEventHandler(router);
attachPutEventHandler(router);
attachDeleteEventHandler(router);

export const eventsRouter = router;
