/**
 * Custom-code review — a super's sign-off on the exact version hash of an app
 * version carrying custom cards (docs/specs/20261011-tables-apps-advanced.md §1,
 * D10; manifest 1.5.0, capability `tables.apps.review`, super only like
 * featuring).
 *
 * Phase 2 foundation placeholders: slice S replaces them — the queue
 * (`listAppCustomReviews` `{}` → `{items: AppCustomReviewItem[]}`) and the
 * decision (`reviewAppCustomCode` `{appId, version} & AppCustomReviewInput` →
 * `AppVersionSummary`; the `hash` must equal the version's `spec_hash`), stored in
 * `table_app_versions.custom_review` (`TableAppCustomReviewRecord`), plus the
 * publish / audience gate in `./apps.ts` (see `customCardsBlockPublish`).
 */

import { notImplemented, type TablesHandlers } from './shared.js';

export const appReviewHandlers = {
  listAppCustomReviews: notImplemented,
  reviewAppCustomCode: notImplemented,
} satisfies TablesHandlers;
