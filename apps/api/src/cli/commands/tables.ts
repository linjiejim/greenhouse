/**
 * `cli tables` — the administrator half of Tables' delete story.
 *
 * Deleting a Base or a table archives it; nothing in the web UI can bring one
 * back, on purpose (spec D2: record-level mistakes are self-service, structural
 * ones cost a conversation with an admin). This command is the other end of
 * that promise — without it, "an administrator can restore it" would be a
 * claim the product cannot honour.
 *
 * Deleted *records* are not here: they have a recycle bin inside the table.
 */

import chalk from 'chalk';
import { openDb, parseFlags, flagBool, flagNum, splitSub, table, heading, dim } from './shared.js';

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'list-archived');
  if (sub === 'list-archived') return listArchived(rest);
  if (sub === 'restore-base') return restoreBase(rest);
  if (sub === 'restore-table') return restoreTable(rest);
  console.error(chalk.red(`Unknown tables subcommand: ${sub}`));
  console.log('Usage: pnpm cli tables [list-archived | restore-base <id> | restore-table <id>]');
  return 1;
}

async function listArchived(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();
  const [bases, tables] = await Promise.all([
    db.tables.listArchivedBases(),
    db.tables.listArchivedTables(flagNum(flags, 'base', 0) || undefined),
  ]);

  if (flagBool(flags, 'json')) {
    console.log(JSON.stringify({ bases, tables }, null, 2));
    return 0;
  }

  const owners = new Map((await db.users.list()).map((user) => [user.id, user.email]));

  console.log(heading(`Archived Bases (${bases.length})`));
  if (!bases.length) {
    console.log(dim('  (none)'));
  } else {
    console.log(
      table(
        ['ID', 'Name', 'Owner', 'Archived'],
        bases.map((base) => [
          String(base.id),
          base.name,
          owners.get(base.owner_id) ?? base.owner_id.slice(0, 8),
          (base.archived_at ?? '').slice(0, 16).replace('T', ' '),
        ]),
      ),
    );
  }

  console.log(heading(`Archived tables (${tables.length})`));
  if (!tables.length) {
    console.log(dim('  (none)'));
  } else {
    const baseNames = new Map<number, string>();
    for (const definition of tables) {
      if (!baseNames.has(definition.base_id)) {
        const base = await db.tables.getBase(definition.base_id);
        baseNames.set(definition.base_id, base ? base.name : '(base missing)');
      }
    }
    console.log(
      table(
        ['ID', 'Name', 'Base', 'Archived'],
        tables.map((definition) => [
          String(definition.id),
          definition.name,
          `${baseNames.get(definition.base_id)} (#${definition.base_id})`,
          (definition.archived_at ?? '').slice(0, 16).replace('T', ' '),
        ]),
      ),
    );
  }

  console.log(dim('\nRestore with: pnpm cli tables restore-base <id> | restore-table <id>'));
  return 0;
}

async function restoreBase(args: string[]): Promise<number> {
  const { positionals } = parseFlags(args);
  const id = Number(positionals[0]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error('Usage: pnpm cli tables restore-base <id>');
    return 1;
  }
  const db = await openDb();
  const existing = await db.tables.getBase(id);
  if (!existing) {
    console.error(chalk.red(`Base not found: ${id}`));
    return 1;
  }
  if (!existing.archived_at) {
    console.log(chalk.yellow(`Base #${id} "${existing.name}" is not archived — nothing to do.`));
    return 0;
  }
  const base = await db.tables.restoreBase(id);
  console.log(chalk.green(`Restored Base #${id} "${base?.name}".`));
  const archivedTables = await db.tables.listArchivedTables(id);
  if (archivedTables.length) {
    console.log(
      dim(
        `  ${archivedTables.length} table(s) inside it are still archived and stay hidden: ` +
          `${archivedTables.map((definition) => `#${definition.id} ${definition.name}`).join(', ')}`,
      ),
    );
  }
  return 0;
}

async function restoreTable(args: string[]): Promise<number> {
  const { positionals } = parseFlags(args);
  const id = Number(positionals[0]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error('Usage: pnpm cli tables restore-table <id>');
    return 1;
  }
  const db = await openDb();
  const existing = await db.tables.getTable(id);
  if (!existing) {
    console.error(chalk.red(`Table not found: ${id}`));
    return 1;
  }
  if (!existing.archived_at) {
    console.log(chalk.yellow(`Table #${id} "${existing.name}" is not archived — nothing to do.`));
    return 0;
  }
  const restored = await db.tables.restoreTable(id);
  console.log(chalk.green(`Restored table #${id} "${restored?.name}".`));
  // Restoring a table inside an archived Base leaves it just as invisible, and
  // silence here would read as success.
  const base = await db.tables.getBase(existing.base_id);
  if (base?.archived_at) {
    console.log(
      chalk.yellow(
        `  Its Base #${base.id} "${base.name}" is still archived, so the table stays hidden. ` +
          `Restore it too: pnpm cli tables restore-base ${base.id}`,
      ),
    );
  }
  return 0;
}
