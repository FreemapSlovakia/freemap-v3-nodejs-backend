import Router from '@koa/router';
import { attachEventCoverHandlers } from './coverHandlers.js';
import { attachDeleteEventHandler } from './deleteEventHandler.js';
import { attachGetEventHandler } from './getEventHandler.js';
import { attachGetEventsHandler } from './getEventsHandler.js';
import { attachOrganizerHandlers } from './organizerHandlers.js';
import { attachParticipantsHandler } from './participantsHandler.js';
import { attachParticipationHandlers } from './participationHandlers.js';
import { attachPatchEventHandler } from './patchEventHandler.js';
import { attachPostEventHandler } from './postEventHandler.js';
import { attachSourceHandler } from './sourceHandler.js';

const router = new Router();

attachGetEventsHandler(router);
attachOrganizerHandlers(router);
attachSourceHandler(router);
attachEventCoverHandlers(router);
attachParticipationHandlers(router);
attachParticipantsHandler(router);
attachPostEventHandler(router);
attachGetEventHandler(router);
attachPatchEventHandler(router);
attachDeleteEventHandler(router);

export const eventsRouter = router;
