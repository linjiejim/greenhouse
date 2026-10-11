/**
 * AI fields — fill / regenerate / status (docs/specs/20261011-tables-apps-advanced.md
 * §2, D2, D6; manifest 1.5.0).
 *
 * Phase 2 foundation placeholders: slice AI replaces them. Payloads
 * (`routes/tables/schema.ts`): fill `{fieldId}` (empty cells only) and
 * regenerate `{fieldId, recordIds?}` (every record, or just these — a failed
 * cell's retry) → `TableAiFieldRunResult`; status `{fieldId, recordIds?}` →
 * `TableAiFieldStatusView`. Fill and regenerate only enqueue
 * `table_recompute_jobs` rows of kind `ai`; the worker generates, charged to the
 * field's creator under the field's monthly cap (`tables_field` budget scope).
 */

import { notImplemented, type TablesHandlers } from './shared.js';

export const aiFieldHandlers = {
  fillAiField: notImplemented,
  regenerateAiField: notImplemented,
  getAiFieldStatus: notImplemented,
} satisfies TablesHandlers;
