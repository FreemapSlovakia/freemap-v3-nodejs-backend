import type { Socket } from 'net';
import type { Logger } from 'pino';
import type z from 'zod';
import type { UserRowSchema } from './types.js';

export type User = z.infer<typeof UserRowSchema> & {
  authProviders: string[];
  authToken: string;
  /** Backward-compatible flag: true when the user holds any role. */
  isAdmin: boolean;
};

declare module 'koa' {
  interface DefaultState {
    user?: User;
    [key: `${string}`]: never;
  }

  type PropertyKey = never;

  interface ExtendableContext {
    log: Logger;
    websocket: WebSocket & Socket;
    reqId: string;
    params: Record<string, string>;
  }
}
