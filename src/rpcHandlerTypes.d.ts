import { ParameterizedContext } from 'koa';
import type { TrackPointListener } from './trackRegister.js';

export type RpcContext = {
  respondResult: (result: unknown) => void;
  respondError: (errorCode: number, message: string) => void;
  ctx: ParameterizedContext;
  listener: TrackPointListener;
};
