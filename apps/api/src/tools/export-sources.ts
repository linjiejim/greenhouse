/**
 * Export sources contributed by extensions.
 *
 * `export_data` ships two sources of its own — `inline` rows the model already
 * has, and `tables_records` read through the Tables adapter. An extension that
 * owns a dataset worth exporting whole registers a third here instead of
 * editing that tool, the way a new search lane registers in `search/sources.ts`.
 *
 * A source is read-only and must apply its own authorization: `export_data`
 * only persists an already-authorized result as a session file artifact.
 */
import type { ZodObject, ZodRawShape } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';

export interface ExportColumn {
  key: string;
  label: string;
}

export interface ExportDataset {
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
  defaultFilename: string;
  defaultSheetName: string;
}

export interface ExportSourceContext {
  userId: string;
  sessionId: string;
}

export interface ExtensionExportSource {
  /** Discriminator value, e.g. `crm_customers`. Namespace it with your extension. */
  type: string;
  /**
   * The source's own object schema — it must declare `type: z.literal('<type>')`
   * so it can join the tool's discriminated union.
   */
  schema: ZodObject<ZodRawShape>;
  /** One line for the tool description, so the model knows when to pick it. */
  describe: string;
  load: (source: Record<string, unknown>, ctx: ExportSourceContext, db: DatabaseProvider) => Promise<ExportDataset>;
}

const sources: ExtensionExportSource[] = [];

export function registerExportSources(defs: readonly ExtensionExportSource[]): void {
  for (const def of defs) {
    if (sources.some((s) => s.type === def.type)) throw new Error(`Export source "${def.type}" is already registered`);
    sources.push(def);
  }
}

export function extensionExportSources(): readonly ExtensionExportSource[] {
  return sources;
}

/** Test hook — forget sources registered by a suite. */
export function _resetExtensionExportSources(): void {
  sources.length = 0;
}
