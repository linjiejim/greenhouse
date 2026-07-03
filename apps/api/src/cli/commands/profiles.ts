/**
 * `admin profiles` — list built-in (TS) profiles + custom (DB) profiles.
 *
 * Built-ins come from the in-process registry; custom profiles are read
 * directly from `custom_profiles` (there is no cross-user list service).
 */

import { sql } from 'drizzle-orm';
import { loadAllProfiles } from '../../profile.js';
import { openDb, parseFlags, flagBool, table, heading, dim, truncate } from './shared.js';

interface CustomProfileRow {
  id: number;
  slug: string;
  user_id: string;
  name: string;
  base_profile_id: string;
  is_shared: boolean;
  updated_at: string;
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseFlags(args.filter((a) => a !== 'list'));
  const json = flagBool(flags, 'json');

  const builtins = loadAllProfiles();
  const db = await openDb();
  const custom = (await db
    .executeRaw(
      sql`SELECT id, slug, user_id, name, base_profile_id, is_shared, updated_at
          FROM custom_profiles ORDER BY id`,
    )
    .catch(() => [])) as CustomProfileRow[];

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

  console.log(heading(`Custom profiles (${custom.length})`));
  if (!custom.length) {
    console.log(dim('  (none)'));
  } else {
    console.log(
      table(
        ['ID', 'Slug', 'Name', 'Base', 'Visibility', 'Owner'],
        custom.map((r) => [
          String(r.id),
          r.slug,
          truncate(r.name, 24),
          r.base_profile_id,
          r.is_shared ? 'shared' : dim('private'),
          String(r.user_id).slice(0, 8),
        ]),
      ),
    );
  }
  return 0;
}
