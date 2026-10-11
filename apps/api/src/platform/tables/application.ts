/**
 * Tables runtime application — the composed registration.
 *
 * Every HTTP / Agent / MCP call dispatches these handlers through
 * `runtime.dispatch` (capability → handler → audit). Each domain keeps its
 * handlers in `handlers/<domain>.ts`; access is resolved only in `access.ts`;
 * audit resources live in `audit.ts`. The map below is typed by the manifest's
 * action ids, so a declared action without a handler fails typecheck (and the
 * kernel registry refuses it at boot).
 */

import { isTablesForbiddenError, TablesValidationError } from '@greenhouse/db';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { tablesManifest, type TablesActionId } from '../manifests/tables.js';
import type { PlatformRegistration } from '../runtime.js';
import { listBaseAudit, tablesAuditScope } from './audit.js';
import { appHandlers } from './handlers/apps.js';
import { activityHandlers } from './handlers/activity.js';
import { automationHandlers } from './handlers/automations.js';
import { baseHandlers } from './handlers/bases.js';
import { dashboardHandlers } from './handlers/dashboards.js';
import { formHandlers } from './handlers/forms.js';
import { importHandlers } from './handlers/imports.js';
import { recordHandlers } from './handlers/records.js';
import { roleHandlers } from './handlers/roles.js';
import { schemaHandlers } from './handlers/schema.js';
import { viewHandlers } from './handlers/views.js';
import { fail, type Handler } from './handlers/shared.js';

/**
 * Domain errors → action failures. Writes outside the caller's rights
 * (`field_not_editable`, `create_forbidden`, `delete_forbidden`) are 403 with
 * that code as `details.reason`; every other validation error — including a
 * filter / sort / group on a field the caller cannot read — is a plain 400. The
 * unreadable-field code is deliberately not surfaced: its message matches a
 * missing field's, so the response cannot tell hidden from absent. Rows outside
 * the scope never reach here: the db returns them as not found and the handler
 * answers 404.
 */
function wrap(handler: Handler): Handler {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (isTablesForbiddenError(error)) return fail('FORBIDDEN', error.message, { reason: error.code });
      if (error instanceof TablesValidationError) return fail('INVALID_INPUT', error.message);
      // Drizzle puts the pg code on err.cause, so the old top-level-only check
      // never matched and every duplicate name surfaced as a 500 instead.
      if (isUniqueViolation(error)) return fail('CONFLICT', 'A resource with this name already exists');
      throw error;
    }
  };
}

export const TABLES_HANDLERS: Readonly<Record<TablesActionId, Handler>> = {
  ...baseHandlers,
  listBaseAudit,
  ...roleHandlers,
  ...schemaHandlers,
  ...viewHandlers,
  ...formHandlers,
  ...recordHandlers,
  ...activityHandlers,
  ...importHandlers,
  ...automationHandlers,
  ...dashboardHandlers,
  ...appHandlers,
};

export const tablesRegistration: PlatformRegistration = {
  manifest: tablesManifest,
  handlers: Object.fromEntries(Object.entries(TABLES_HANDLERS).map(([id, handler]) => [id, wrap(handler)])),
  // Every Tables event is filed under its Base (resolved before the handler runs).
  auditScope: tablesAuditScope,
};
