/**
 * Table cards — the one renderer set for `TableCardSpec` results (program P1):
 * Tables dashboards now, app pages in Phase 1. Evaluation is server-side
 * (`platform/tables/cards.ts`); these only draw results and report clicks.
 */

export { TableCardView, type TableCardViewProps } from './table-card';
export { KpiCard } from './kpi-card';
export { ChartCard } from './chart-card';
export { PivotCard, buildPivotModel } from './pivot-card';
export { RecordsCard, RecordsTable, recordColumns } from './records-card';
export { TextCard } from './text-card';
export { FilterBar, effectiveFilterValue, type DashboardFilterValues } from './filter-bar';
export { DrilldownDrawer, type DrilldownRequest } from './drilldown-drawer';
export { buildChartModel, valueCaption } from './chart-model';
export {
  dimensionLabel,
  dimensionSlot,
  dimensionTitle,
  formatCardNumber,
  useCardLabels,
  type CardLabelContext,
} from './card-labels';
