/**
 * CRUD Framework Demo route — /api/crud/demo (super-only).
 *
 * The end-to-end reference for @greenhouse/crud on the server side: a Drizzle
 * table (crud_demo_items) → createTableCrudService → createCrudRoutes. Mounted
 * OUTSIDE the AppType contract (generic protocol; the web demo talks to it via
 * createRestDataSource, not hc). Built lazily in main() once the DB exists.
 */

import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import { createCrudRoutes } from '@greenhouse/crud/server';
import { requireSuper } from '../auth/middleware.js';

const demoBody = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.enum(['plant', 'device', 'sensor', 'other']).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  is_featured: z.boolean().optional(),
  tags: z.array(z.string()).nullable().optional(),
  notes: z.string().nullable().optional(),
});

function parseDemo(raw: unknown, requireName: boolean): Record<string, unknown> {
  const parsed = demoBody.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  if (requireName && !parsed.data.name) throw new Error('name is required');
  return parsed.data as Record<string, unknown>;
}

export function createCrudDemoRoutes() {
  const su = requireSuper();
  return createCrudRoutes(getDb().crudDemo, {
    filterable: {
      name: { type: 'text', methods: ['like'] },
      category: { type: 'text', methods: ['eq', 'in'] },
      status: { type: 'text', methods: ['eq', 'in'] },
      is_featured: { type: 'boolean', methods: ['eq'] },
      priority: { type: 'number', methods: ['eq', 'gte', 'lte'] },
    },
    sortable: ['name', 'priority', 'created_at', 'updated_at'],
    defaultSort: { key: 'created_at', order: 'desc' },
    guards: { read: [su], write: [su], delete: [su] },
    parseCreate: (raw) => parseDemo(raw, true),
    parseUpdate: (raw) => parseDemo(raw, false),
  });
}
