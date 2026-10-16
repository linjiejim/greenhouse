import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError, invalidInput } from './errors.js';

/**
 * No JSON body is larger than this, in any module (a route may keep a lower limit of its own):
 * generous, so it only stops a body no client sends on purpose.
 */
export const JSON_BODY_MAX_BYTES = 16 * 1024 * 1024;

const tooLarge = () => new ApiError(413, 'too_large', 'This request is too large.');

function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** A body that does not say how long it is, read up to `max` bytes. */
async function readCapped(request: Request, max: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse the JSON body against a schema, or answer 400 invalid_input (413 past JSON_BODY_MAX_BYTES). */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const declared = c.req.header('content-length');
  if (declared !== undefined && Number(declared) > JSON_BODY_MAX_BYTES) throw tooLarge();
  let body: unknown;
  try {
    const text = declared !== undefined ? await c.req.text() : await readCapped(c.req.raw, JSON_BODY_MAX_BYTES);
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
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
