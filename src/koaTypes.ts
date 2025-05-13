import { PoolConnection } from 'mariadb';
import { Socket } from 'net';

export type User = {
  id: number;
  isAdmin: boolean;
  isPremium: boolean;
  name: string;
  facebookUserId: string | null;
  osmId: string | null;
  garminUserId: string | null;
  googleUserId: string | null;
  garminAccessToken: string | null;
  garminAccessTokenSecret: string | null;
  authToken?: string;
};

declare module 'koa' {
  interface DefaultState {
    user?: User;
    dbConn?: PoolConnection;
    [key: `${string}`]: never;
  }

  type PropertyKey = never;

  interface DefaultContext {
    websocket: WebSocket & Socket;
    reqId: string;
    params: Record<string, string>;
  }
}
