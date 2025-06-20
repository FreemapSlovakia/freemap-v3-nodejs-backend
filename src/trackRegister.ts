import WebSocket from 'ws';

export const trackRegister = new Map<number | string, Set<WebSocket>>();
