/**
 * Routes of cards.ts, mounted at /api/tables. Being written.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../http/env.js';
import type { CardsPart } from './cards.js';

export function cardsRoutes(part: CardsPart) {
  void part;
  return new Hono<AppEnv>();
}
