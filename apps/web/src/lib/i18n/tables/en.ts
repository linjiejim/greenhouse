/**
 * Tables copy, split per Phase 0 slice so parallel slices never edit the same
 * catalog lines. Each `<slice>.en.ts` owns one namespace under `tables`
 * (`tables.forms.*`, `tables.automations.*`, …); this file spreads them once
 * into `../en.ts`. The slice test pins that no two modules (and no core key)
 * claim the same namespace.
 */

import { tablesAccessEn } from './access.en';
import { tablesActivityEn } from './activity.en';
import { tablesAutomationsEn } from './automations.en';
import { tablesDashboardsEn } from './dashboards.en';
import { tablesFormsEn } from './forms.en';
import { tablesFormulaEn } from './formula.en';
import { tablesImportsEn } from './imports.en';
import { tablesViewsEn } from './views.en';

export const TABLES_SLICE_MODULES_EN = {
  access: tablesAccessEn,
  activity: tablesActivityEn,
  automations: tablesAutomationsEn,
  dashboards: tablesDashboardsEn,
  forms: tablesFormsEn,
  formula: tablesFormulaEn,
  imports: tablesImportsEn,
  views: tablesViewsEn,
} as const;

export const TABLES_SLICES_EN = {
  ...tablesAccessEn,
  ...tablesActivityEn,
  ...tablesAutomationsEn,
  ...tablesDashboardsEn,
  ...tablesFormsEn,
  ...tablesFormulaEn,
  ...tablesImportsEn,
  ...tablesViewsEn,
} as const;

export { tablesPlanEn as TABLES_PLAN_EN } from './plan.en';
