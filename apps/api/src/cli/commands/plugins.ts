/** Plugin inventory and explicit data removal; enablement stays in deployment configuration. */
import { listPlugins, pluginDropPlan, pluginStatus } from '../../extensions/status.js';
import { openDb, parseFlags, table } from './shared.js';

export async function run(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const [command = 'list', id] = positionals;
  if (command === 'list' || command === 'status') {
    const rows = command === 'list' ? listPlugins() : await pluginStatus(await openDb());
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else
      console.log(
        table(
          [
            'Plugin',
            'Compiled',
            'Enabled',
            'SDK',
            'Version',
            'Depends on',
            ...(command === 'status' ? ['Migrations', 'Boot', 'Errors'] : []),
          ],
          rows.map((row) => [
            row.id,
            String(row.compiled),
            String(row.enabled),
            String(row.sdk ?? '—'),
            row.version ?? '—',
            row.dependsOn.join(', ') || '—',
            ...('migrationState' in row
              ? [
                  String(row.migrationState),
                  row.bootState,
                  [
                    ...row.bootErrors,
                    ...('migrationError' in row && row.migrationError ? [String(row.migrationError)] : []),
                  ].join('; ') || '—',
                ]
              : []),
          ]),
        ),
      );
    return 0;
  }
  if (command === 'drop' && id) {
    const plan = pluginDropPlan(id);
    console.log(
      `Plugin "${id}" tables to drop: ${plan.tables.join(', ') || '(none)'}. Lane rows will also be removed.`,
    );
    if (flags.yes !== true) {
      console.error('No changes made. Pass --yes to drop these tables and migration rows.');
      return 1;
    }
    const dropped = await (await openDb()).extensionMigrations.drop(plan.source, plan.resetTables);
    console.log(`Dropped plugin "${id}": ${dropped.join(', ') || '(no tables)'}`);
    return 0;
  }
  console.error('Usage: pnpm cli plugins list | status [--json] | drop <id> --yes');
  return 1;
}
