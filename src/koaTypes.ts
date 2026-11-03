import type { Socket } from 'node:net';
import type { Logger } from 'pino';
import type z from 'zod';
import type { AppTokenScope } from './appTokens.js';
import type { UserRowSchema } from './types.js';

export type User = z.infer<typeof UserRowSchema> & {
  authProviders: string[];
  authToken: string;
  /** Set when the request authenticated with an app token, not a session. */
  appToken: { id: number; scopes: AppTokenScope[] } | null;
  /** Backward-compatible flag: true when the user holds any role. */
  isAdmin: boolean;
  osmGpxAuthorized: boolean;
};

declare module 'koa' {
  interface DefaultState {
    user?: User;
  }

  interface ExtendableContext {
    log: Logger;
    websocket: WebSocket & Socket;
    reqId: string;
    params: Record<string, string>;
  }
}
