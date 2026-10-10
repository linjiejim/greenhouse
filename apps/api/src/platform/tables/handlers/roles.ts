/**
 * Custom Base roles (row / field rules) — slice A. Declared in the manifest
 * (owner-only, custom roles refused); every handler is a placeholder until A lands.
 */

import { notImplemented, type TablesHandlers } from './shared.js';

export const roleHandlers = {
  listRoles: notImplemented,
  createRole: notImplemented,
  updateRole: notImplemented,
  deleteRole: notImplemented,
} satisfies TablesHandlers;
