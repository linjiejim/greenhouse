/**
 * Zod schemas for the wire protocol — used by the server route factory to
 * reject malformed list requests loudly (400) instead of silently dropping
 * filters the way the letpot-era code did.
 */

import { z } from 'zod';

export const filterMethodSchema = z.enum([
  'eq',
  'ne',
  'like',
  'ilike',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'exists',
]);

export const filterItemSchema = z.object({
  key: z.string().min(1),
  method: filterMethodSchema,
  value: z.array(z.unknown()),
});

export const sortItemSchema = z.object({
  key: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

export const listParamsSchema = z.object({
  skip: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
  filter: z.array(filterItemSchema).optional(),
  sort: z.array(sortItemSchema).optional(),
});

export type ParsedListParams = z.infer<typeof listParamsSchema>;
