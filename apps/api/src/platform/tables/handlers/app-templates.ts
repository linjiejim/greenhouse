/**
 * App templates — the lifecycle actions (docs/specs/20261011-tables-apps-advanced.md
 * §6, D9, D12; manifest 1.5.0).
 *
 * Phase 2 foundation placeholders: slice T replaces each with the lifecycle on
 * `table_app_templates` / `table_app_template_versions` (built-ins synced from
 * the repo; "save as template" from an app the caller manages; semver +
 * changelog + content hash + scan; super review for versions carrying custom
 * cards or automations; install through `applySchemaPlan` as the installer —
 * automations disabled, webhooks and fixed recipients stripped, never
 * idempotent). Until then the Phase 1 routes `GET /api/apps/templates` and
 * `POST /api/apps/templates/:key/install` keep serving the built-in catalog
 * directly (`routes/app-templates.ts`).
 *
 * Payloads (`routes/app-templates.ts`): list `{}` → `{templates: AppTemplateSummary[]}`;
 * get `{key}` → `AppTemplateDetailView`; publish `AppTemplatePublishInput`
 * (`key` from the path for a new version) → `AppTemplateDetailView`; review
 * `{key, version} & AppTemplateReviewInput` (super) → `AppTemplateVersionView`;
 * install `{key}` → `AppTemplateInstallResult`; archive `{key}` → `AppTemplateDetailView`.
 */

import { notImplemented, type TablesHandlers } from './shared.js';

export const appTemplateHandlers = {
  listAppTemplates: notImplemented,
  getAppTemplate: notImplemented,
  publishAppTemplate: notImplemented,
  reviewAppTemplate: notImplemented,
  installAppTemplate: notImplemented,
  archiveAppTemplate: notImplemented,
} satisfies TablesHandlers;
