import { toErrorMessage } from '@greenhouse/utils/error';
/** Shared operator read model for the super-only route and CLI. */
import { extensionMigrationTables, type DatabaseProvider, type ExtensionMigrationSource } from '@greenhouse/db';
import type { PluginHostEntry, PluginHostStatus } from '@greenhouse/types/plugin-host';
import { COMPILED_EXTENSIONS, EXTENSIONS } from './index.js';
import { COMPILED_PLUGIN_PACKAGES } from './compiled.generated.js';
import { extensionBootFact } from './health.js';

export function listPlugins(): PluginHostEntry[] {
  return COMPILED_EXTENSIONS.map((ext) => {
    const pkg = COMPILED_PLUGIN_PACKAGES.find((item) => item.id === ext.id);
    const enabled = EXTENSIONS.some((item) => item.id === ext.id);
    const boot = extensionBootFact(ext.id);
    return {
      id: ext.id,
      name: ext.name,
      packageName: pkg?.packageName ?? null,
      compiled: true,
      enabled,
      sdk: ext.sdk ?? null,
      version: ext.version ?? pkg?.manifest.version ?? null,
      dependsOn: ext.dependsOn ?? [],
      bootState: enabled ? boot.state : 'disabled',
      bootErrors: boot.errors,
    };
  });
}

export async function pluginStatus(db: DatabaseProvider): Promise<PluginHostStatus[]> {
  const out: PluginHostStatus[] = [];
  for (const entry of listPlugins()) {
    const ext = COMPILED_EXTENSIONS.find((item) => item.id === entry.id)!;
    try {
      const migrations = ext.migrations
        ? await db.extensionMigrations.status([{ extensionId: ext.id, dir: ext.migrations.dir }])
        : [];
      const broken = migrations.some(
        (file) => file.drifted || file.collidesWithCore.length || file.state === 'missing',
      );
      out.push({
        ...entry,
        migrationState: !migrations.length
          ? 'none'
          : broken
            ? 'error'
            : migrations.some((file) => !file.applied)
              ? 'pending'
              : 'applied',
        migrationError: null,
        migrations: migrations.map(({ name, state, applied, drifted }) => ({ name, state, applied, drifted })),
      });
    } catch (error) {
      out.push({
        ...entry,
        migrationState: 'error',
        migrationError: toErrorMessage(error),
        migrations: [],
      });
    }
  }
  return out;
}

/** A concrete, reviewable drop plan; no database is opened or changed. */
export function pluginDropPlan(id: string): {
  source: ExtensionMigrationSource;
  tables: string[];
  resetTables: string[];
} {
  const ext = COMPILED_EXTENSIONS.find((item) => item.id === id);
  if (!ext) throw new Error(`Unknown compiled plugin "${id}"`);
  if (EXTENSIONS.some((item) => item.id === id))
    throw new Error(`Disable plugin "${id}" in configuration and restart before dropping its tables`);
  const source = { extensionId: id, dir: ext.migrations?.dir ?? '' };
  const resetTables = ext.resetTables ?? [];
  const tables = extensionMigrationTables(source, resetTables);
  for (const other of COMPILED_EXTENSIONS) {
    if (other.id === id) continue;
    const owned = extensionMigrationTables(
      { extensionId: other.id, dir: other.migrations?.dir ?? '' },
      other.resetTables,
    );
    if (tables.some((table) => owned.includes(table)))
      throw new Error(`Plugin "${id}" shares table ownership with "${other.id}"`);
  }
  return { source, tables, resetTables };
}
