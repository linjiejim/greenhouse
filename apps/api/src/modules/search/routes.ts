/**
 * GET /api/search?q=&kinds=conversations,messages,agents,members&limit=   ⌘K: a few of each kind
 */

import { Hono } from 'hono';
import { searchQuerySchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readQuery } from '../../http/validate.js';
import type { SearchService } from './service.js';

export function searchRoutes(service: SearchService) {
  return new Hono<AppEnv>().get('/', async (c) =>
    c.json(await service.search(c.get('member').id, readQuery(c, searchQuerySchema))),
  );
}
