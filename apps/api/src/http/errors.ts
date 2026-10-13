import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { logger } from '@greenhouse/utils/logger';

/** Every failure leaves the API as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const invalidInput = (message: string, details?: unknown) =>
  new ApiError(400, 'invalid_input', message, details);
export const unauthorized = (message = 'Sign in again.') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.') => new ApiError(403, 'forbidden', message);
export const notFound = (what = 'Item') => new ApiError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function handleError(error: Error, c: Context) {
  if (error instanceof ApiError) return c.json(errorBody(error.code, error.message, error.details), error.status);
  logger.error(`[api] ${c.req.method} ${c.req.path} failed`, error);
  return c.json(errorBody('internal', 'Something went wrong. Try again.'), 500);
}

export function handleNotFound(c: Context) {
  return c.json(errorBody('not_found', 'No such endpoint.'), 404);
}
