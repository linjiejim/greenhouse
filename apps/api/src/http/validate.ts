import type { Context } from 'hono';
import type { z } from 'zod';
import { invalidInput } from './errors.js';

function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Parse the JSON body against a schema, or answer 400 invalid_input. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidInput('The request body must be JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidInput('Some fields are invalid.', issues(parsed.error));
  return parsed.data;
}

export function readQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalidInput('Some query parameters are invalid.', issues(parsed.error));
  return parsed.data;
}

/** Parse one path parameter, or answer 400 invalid_input. */
export function readParam<T extends z.ZodType>(c: Context, name: string, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.param(name));
  if (!parsed.success) throw invalidInput(`The ${name} in the path is invalid.`, issues(parsed.error));
  return parsed.data;
}
