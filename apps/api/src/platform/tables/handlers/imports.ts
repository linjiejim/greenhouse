/**
 * CSV / Excel import — slice I. `previewImport` (multipart ≤ 10 MB → columns,
 * samples, suggested mapping) and `commitImport` (resumable, 100 rows per
 * transaction, never enqueues automations) are declared, not built.
 */

import { notImplemented, type TablesHandlers } from './shared.js';

export const importHandlers = {
  previewImport: notImplemented,
  commitImport: notImplemented,
} satisfies TablesHandlers;
