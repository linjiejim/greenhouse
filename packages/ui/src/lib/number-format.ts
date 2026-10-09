/**
 * Number display for single headline figures — the workbench KPI card and the
 * chat `stats` block read them the same way. Thousands get grouping without
 * decimals; small numbers stay as written (0.25 is not "0").
 */
export function formatKpi(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(value);
  }
  // Aggregates arrive as numeric strings from raw SQL often enough to be worth handling.
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return formatKpi(Number(value));
  }
  return null;
}
