/**
 * `admin` — the Greenhouse dev/ops console.
 *
 * A single entry point for the quick operations a project developer or admin
 * needs against a local/self-hosted deployment: inspect users, tools, profiles
 * and sessions; seed/reset the database; mint API clients; and health-check a
 * fresh clone. Everything runs in-process against the DB + registries (no
 * running server required).
 *
 *   pnpm admin <command> [subcommand] [args] [--flags]
 *
 * Each command lives in ./admin/<command>.ts and exports `run(args)`. Commands
 * are imported lazily so a cheap command (e.g. `tools`) never pays to load the
 * DB, and a broken module can't take down the whole console.
 */

import chalk from 'chalk';
import { PRODUCT_NAME } from '@greenhouse/utils/brand';
import { closeDb } from './admin/shared.js';

const USAGE = `${chalk.bold(`${PRODUCT_NAME} admin console`)} — dev/ops quick operations

${chalk.bold('Usage:')} pnpm admin <command> [subcommand] [args] [--flags]

${chalk.bold('Inspect')}
  users [list]              List users (--role <r>, --json)
  users show <id|email>     Show one user + their session count
  tools [list]              List agent tools + summaries (--category <c>, --json)
  profiles [list]           List built-in + custom agent profiles (--json)
  sessions [list]           Recent sessions (--user, --channel, --status, --limit, --json)
  sessions show <id>        Session detail + full transcript (--verbose, --json)
  stats                     One-glance row counts + DB health (--json)

${chalk.bold('Manage')}
  users create              Create a user (--email --password --nickname --role)
  seed                      Load the example dataset (--reset | --keep, --password, --yes)
  db reset                  Wipe ALL data — truncate every table (--yes)
  api-client create [id]    Mint/rotate an external API key (--profiles a,b)
  api-client list           List external API clients (--json)

${chalk.bold('Diagnose')}
  doctor                    Check env + DB readiness for this deployment

${chalk.dim('Global: --json (machine output where supported). DB via DATABASE_URL in .env.')}`;

async function dispatch(command: string, rest: string[]): Promise<number> {
  switch (command) {
    case 'users':
    case 'user':
      return (await import('./admin/users.js')).run(rest);
    case 'tools':
    case 'tool':
      return (await import('./admin/tools.js')).run(rest);
    case 'profiles':
    case 'profile':
      return (await import('./admin/profiles.js')).run(rest);
    case 'sessions':
    case 'session':
      return (await import('./admin/sessions.js')).run(rest);
    case 'seed':
      return (await import('./admin/seed.js')).run(rest);
    case 'db':
      return (await import('./admin/db.js')).run(rest);
    case 'reset':
      return (await import('./admin/db.js')).run(['reset', ...rest]);
    case 'stats':
    case 'overview':
      return (await import('./admin/db.js')).run(['stats', ...rest]);
    case 'doctor':
    case 'check':
      return (await import('./admin/doctor.js')).run(rest);
    case 'api-client':
    case 'api-clients':
      return (await import('./admin/api-client.js')).run(rest);
    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      console.log('\n' + USAGE);
      return 1;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  return dispatch(command, argv.slice(1));
}

// Set process.exitCode and let Node exit naturally once closeDb() releases the
// DB pool — calling process.exit() here would truncate piped stdout mid-flush.
main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(chalk.red('Error:'), err?.message ?? err);
    await closeDb();
    process.exitCode = 1;
  });
