import * as ws from 'ws';

export const trackRegister = new Map<number | string, Set<ws>>();
