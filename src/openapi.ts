import { ZodOpenApiPathItemObject } from 'zod-openapi';

export const paths: Record<string, ZodOpenApiPathItemObject> = {};

export function registerPath(path: string, item: ZodOpenApiPathItemObject) {
  paths[path] = { ...paths[path], ...item };
}

export const AUTH_REQUIRED: Record<string, string[]>[] = [{ bearerAuth: [] }];

export const AUTH_OPTIONAL: Record<string, string[]>[] = [
  { bearerAuth: [] },
  {},
];
