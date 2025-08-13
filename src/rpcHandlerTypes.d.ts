import { ParameterizedContext } from 'koa';

export type RpcContext = {
  respondResult: (result: unknown) => void;
  respondError: (errorCode: number, message: string) => void;
  ctx: ParameterizedContext;
};
