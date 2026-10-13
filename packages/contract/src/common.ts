import { z } from 'zod';

/** `{ error: { code, message, details? } }`: clients branch on `code`, people read `message`. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** Stable error codes shared by every module. Modules add their own snake_case codes. */
export const ERROR_CODES = [
  'invalid_input',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'unavailable',
  'internal',
] as const;
export type CommonErrorCode = (typeof ERROR_CODES)[number];

export const isoTime = z.string();

/** Cursor pagination: `?cursor=&limit=`, default 50, at most 200. */
export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}
export type Page<T> = { items: T[]; next_cursor: string | null };

export const API_VERSION = 2;
