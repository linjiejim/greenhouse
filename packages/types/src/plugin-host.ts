/**
 * Operator view of compiled / enabled plugins (Administration → Plugins, `pnpm cli plugins`).
 * Separate from the station manifest (`./plugins.ts`), which clients vendor verbatim.
 */
export interface PluginHostEntry {
  id: string;
  name: string;
  packageName: string | null;
  compiled: boolean;
  enabled: boolean;
  sdk: number | null;
  version: string | null;
  dependsOn: string[];
  bootState: 'disabled' | 'not-run' | 'ready' | 'error';
  bootErrors: string[];
}

export interface PluginHostStatus extends PluginHostEntry {
  migrationState: 'none' | 'applied' | 'pending' | 'error';
  migrationError: string | null;
  migrations: {
    name: string;
    state: 'applied' | 'pending' | 'skipped' | 'missing';
    applied: boolean;
    drifted: boolean;
  }[];
}
