/**
 * `admin tools` — enumerate the agent tool registry with one-line summaries.
 *
 * Reads the in-process registry (no DB, no server); grouped by category.
 */

import chalk from 'chalk';
import { getAllToolMetas } from '../../tools/registry.js';
import { parseFlags, flagStr, flagBool, groupBy, table, heading, dim } from './shared.js';

const CATEGORY_ORDER = ['public', 'team', 'super', 'admin', 'local'];

export async function run(args: string[]): Promise<number> {
  const { flags } = parseFlags(args.filter((a) => a !== 'list'));
  let metas = getAllToolMetas();
  const category = flagStr(flags, 'category');
  if (category) metas = metas.filter((m) => m.category === category);

  if (flagBool(flags, 'json')) {
    console.log(JSON.stringify(metas, null, 2));
    return 0;
  }

  console.log(heading(`Tools (${metas.length})`) + dim('   ● = default-on for internal users'));
  const byCat = groupBy(metas, (m) => m.category);
  const cats = [...new Set([...CATEGORY_ORDER, ...Object.keys(byCat)])];
  for (const cat of cats) {
    const list = byCat[cat];
    if (!list?.length) continue;
    console.log('\n' + chalk.bold.cyan(cat) + dim(`  (${list.length})`));
    const rows = list.map((m) => [m.id, m.brief, m.is_global ? chalk.green('●') : '']);
    console.log(table(['ID', 'Summary', ''], rows));
  }
  return 0;
}
