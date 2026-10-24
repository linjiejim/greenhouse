/**
 * `pnpm cli migrate-from-1x --from <1.6 database url> --to <new database url> [--dry-run] [--json]`
 *
 * Carries a Greenhouse 1.6.x database into a fresh 3.0 database (spec A4):
 * the old database is only read; the new one gets the 3.0 baseline when empty
 * and is emptied first when it already holds data, so the command can be
 * repeated. Prints the reconciliation report — rows read / written per source →
 * target table and every skipped row with its reason. Exits 2 when it refuses
 * (a 2.x / pre-1.6 source, a 1.x / foreign target, the same database twice).
 */

import chalk from 'chalk';
import { carryFrom1x, CarryError, type CarryReport } from '@greenhouse/db';
import { flagBool, flagStr, heading, parseFlags, redactDbUrl, table } from './shared.js';

const USAGE = 'Usage: pnpm cli migrate-from-1x --from <1.6 database url> --to <new database url> [--dry-run] [--json]';

function skippedText(skipped: Record<string, number>): string {
  const entries = Object.entries(skipped);
  return entries.length === 0 ? '' : entries.map(([reason, count]) => `${count} ${reason}`).join('; ');
}

export function formatCarryReport(report: CarryReport): string {
  const lines: string[] = [];
  lines.push(
    heading(report.dryRun ? 'migrate-from-1x — dry run (nothing written)' : 'migrate-from-1x — reconciliation'),
  );
  lines.push(`source migrations through ${report.sourceVersion}; ${report.startedAt} → ${report.finishedAt}`);
  lines.push('');
  lines.push(
    table(
      ['source', 'target', 'read', 'written', 'skipped'],
      report.lines.map((line) => [
        line.source,
        line.target,
        String(line.read),
        String(line.written),
        skippedText(line.skipped),
      ]),
    ),
  );
  const unaccounted = report.lines.filter(
    (line) => line.read !== line.written + Object.values(line.skipped).reduce((sum, count) => sum + count, 0),
  );
  if (report.retired.length > 0) {
    lines.push('');
    lines.push(heading('Not carried (whole table)'));
    lines.push(
      table(
        ['table', 'rows', 'reason'],
        report.retired.map((row) => [row.table, String(row.rows), row.reason]),
      ),
    );
  }
  if (report.extensions.length > 0) {
    lines.push('');
    lines.push(heading('Extension tables (copied verbatim)'));
    lines.push(
      table(
        ['table', 'rows'],
        report.extensions.map((row) => [row.table, String(row.rows)]),
      ),
    );
  }
  if (report.notes.length > 0) {
    lines.push('');
    lines.push(heading('Notes'));
    for (const note of report.notes) lines.push(`  • ${note}`);
  }
  lines.push('');
  lines.push(
    unaccounted.length === 0
      ? chalk.green('✓ every source row is accounted for (written or skipped with a reason)')
      : chalk.red(
          `✗ rows unaccounted for in: ${unaccounted.map((line) => `${line.source}→${line.target}`).join(', ')}`,
        ),
  );
  return lines.join('\n');
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const from = flagStr(flags, 'from');
  const to = flagStr(flags, 'to');
  const dryRun = flagBool(flags, 'dry-run');
  if (!from || (!to && !dryRun)) {
    console.error(chalk.red(USAGE));
    return 1;
  }
  const json = flagBool(flags, 'json');
  if (!json) {
    console.log(`from ${redactDbUrl(from)}${to ? `\nto   ${redactDbUrl(to)}` : ''}${dryRun ? '\n(dry run)' : ''}`);
  }
  try {
    const report = await carryFrom1x({
      from,
      to,
      dryRun,
      log: json ? undefined : (line) => console.log(chalk.dim(line)),
    });
    console.log(json ? JSON.stringify(report, null, 2) : formatCarryReport(report));
    return 0;
  } catch (err) {
    if (err instanceof CarryError) {
      console.error(chalk.red('Refusing:'), err.message);
      return 2;
    }
    throw err;
  }
}
