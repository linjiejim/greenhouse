/**
 * Routes of forms.ts, mounted at /api/tables. Being written.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../http/env.js';
import type { FormsPart } from './forms.js';

export function formsRoutes(part: FormsPart) {
  void part;
  return new Hono<AppEnv>();
}
