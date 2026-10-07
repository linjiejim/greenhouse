/**
 * `pnpm cli profiles` — list built-in profiles + every member's Bots.
 *
 * Built-ins come from the in-process registry; Bots are read directly from
 * `bots` (there is no cross-user list service).
 */

import { sql } from 'drizzle-orm';
import { loadAllProfiles } from '../../profiles/profile.js';
import { openDb, parseFlags, flagBool, table, heading, dim, truncate } from './shared.js';

interface BotListRow {
  id: string;
  user_id: string;
  name: string;
  role: string;
  lifecycle_status: string;
  is_shared: boolean;
  status: string;
  updated_at: string;
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseFlags(args.filter((a) => a !== 'list'));
  const json = flagBool(flags, 'json');

  const builtins = loadAllProfiles();
  const db = await openDb();
  const custom = (await db
    .executeRaw(
      sql`SELECT id, user_id, name, role, lifecycle_status, is_shared, status, updated_at
          FROM bots ORDER BY created_at`,
    )
    .catch(() => [])) as BotListRow[];

  if (json) {
    console.log(
      JSON.stringify(
        {
          builtin: builtins.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            hidden: p.hidden ?? false,
            access: p.access,
            model: p.model?.id ?? p.model?.provider,
            tools: p.tools,
          })),
          custom,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(heading(`Built-in profiles (${builtins.length})`));
  console.log(
    table(
      ['ID', 'Name', 'Access', 'Model', 'Tools', 'Description'],
      builtins.map((p) => [
        p.id,
        p.name,
        p.access?.level ?? '—',
        p.model?.id ?? p.model?.provider ?? '—',
        String(p.tools?.length ?? 0),
        truncate(p.description ?? '', 44),
      ]),
    ),
  );

  console.log(heading(`Bots (${custom.length})`));
  if (!custom.length) {
    console.log(dim('  (none)'));
  } else {
    console.log(
      table(
        ['ID', 'Name', 'Role', 'Lifecycle', 'Visibility', 'Status', 'Owner'],
        custom.map((r) => [
          r.id,
          truncate(r.name, 24),
          truncate(r.role, 20),
          r.lifecycle_status,
          r.is_shared ? 'shared' : dim('private'),
          r.status,
          String(r.user_id).slice(0, 8),
        ]),
      ),
    );
  }
  return 0;
}
