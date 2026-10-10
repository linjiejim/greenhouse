/**
 * Pure helpers over the unified card specification (`TableCardSpec` in
 * `./tables`): dashboard widgets now, app cards in Phase 1.
 *
 * The evaluator itself is server-side (apps/api/src/platform/tables/cards.ts);
 * this module holds only what both the server and the clients need to agree on
 * (legacy widget mapping, drill-down predicates, filter-control predicates).
 */

export type {
  TableCardSpec,
  TableDashboardConfig,
  TableDateRangePreset,
  TableFilterControl,
  TableFilterControlKind,
  TableFilterValue,
} from './tables.js';
