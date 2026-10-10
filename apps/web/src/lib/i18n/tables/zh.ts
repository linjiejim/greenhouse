/** Chinese counterpart of ./en.ts — spread once into `../zh.ts`. */

import { tablesAccessZh } from './access.zh';
import { tablesActivityZh } from './activity.zh';
import { tablesAutomationsZh } from './automations.zh';
import { tablesDashboardsZh } from './dashboards.zh';
import { tablesFormsZh } from './forms.zh';
import { tablesFormulaZh } from './formula.zh';
import { tablesImportsZh } from './imports.zh';
import { tablesViewsZh } from './views.zh';

export const TABLES_SLICES_ZH = {
  ...tablesAccessZh,
  ...tablesActivityZh,
  ...tablesAutomationsZh,
  ...tablesDashboardsZh,
  ...tablesFormsZh,
  ...tablesFormulaZh,
  ...tablesImportsZh,
  ...tablesViewsZh,
};

export { tablesPlanZh as TABLES_PLAN_ZH } from './plan.zh';
