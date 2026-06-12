import { Socket } from 'net';
import { Logger } from 'pino';
import z from 'zod';
import { UserRowSchema } from './types.js';

export type User = z.infer<typeof UserRowSchema> & {
  authProviders: string[];
  authToken: string;
  /** Backward-compatible flag: true when the user holds any role. */
  isAdmin: boolean;
  /** Whether the new Polar payment flow is enabled for this user. */
  polarEnabled: boolean;
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
