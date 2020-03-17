import { ParameterizedContext } from 'koa';

export type RpcContext = {
  respondResult: (result: any) => void;
  respondError: (errorCode: number, message: string) => void;
  // params: string[] | { [key: string]: any };
  params: { [key: string]: any };
  ctx: ParameterizedContext;
};
