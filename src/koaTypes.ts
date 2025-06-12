import { PoolConnection } from 'mariadb';
import { Socket } from 'net';

export type User = {
  id: number;
  isAdmin: boolean;
  premiumExpiration: Date | null;
  name: string;
  facebookUserId: string | null;
  osmId: string | null;
  garminUserId: string | null;
  googleUserId: string | null;
  garminAccessToken: string | null;
  garminAccessTokenSecret: string | null;
  authToken: string;
  email?: string;
  authProviders: string[];
  language: string | null;
  lat: number | null;
  lon: number | null;
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

  interface DefaultContext {
    websocket: WebSocket & Socket;
    reqId: string;
    params: Record<string, string>;
  }
}
