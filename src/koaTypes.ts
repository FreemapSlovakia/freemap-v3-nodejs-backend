import { PoolConnection } from 'mariadb';
import { Socket } from 'net';
import { Logger } from 'pino';

export type User = {
  authProviders: string[];
  authToken: string;
  credits: number;
  email?: string;
  facebookUserId: string | null;
  garminAccessToken: string | null;
  garminAccessTokenSecret: string | null;
  garminUserId: string | null;
  googleUserId: string | null;
  id: number;
  isAdmin: boolean;
  language: string | null;
  lat: number | null;
  lon: number | null;
  name: string;
  osmId: string | null;
  premiumExpiration: Date | null;
  sendGalleryEmails: boolean;
  settings: Record<string, unknown> | null;
};

declare module 'koa' {
  interface DefaultState {
    user?: User;
    dbConn?: PoolConnection;
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
