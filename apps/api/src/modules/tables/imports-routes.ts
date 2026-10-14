/**
 * Routes of imports.ts, mounted at /api/tables. Being written.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../http/env.js';
import type { ImportsPart } from './imports.js';

export function importsRoutes(part: ImportsPart) {
  void part;
  return new Hono<AppEnv>();
}
