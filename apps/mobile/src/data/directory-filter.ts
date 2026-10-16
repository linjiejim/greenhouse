import type { BaseSummary } from '../shared/contract';

/** The web directories match loaded names, ignoring case and surrounding spaces. */
export const matchesDirectory = (query: string, ...names: string[]) =>
  names.some((name) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

export function matchesBase(query: string, base: BaseSummary): boolean {
  return matchesDirectory(
    query,
    base.name,
    ...base.tables.flatMap((table) => [table.name, ...table.views.map((view) => view.name)]),
    ...base.dashboards.map((view) => view.name),
  );
}
