/**
 * `cli` — the Greenhouse dev/ops console (`pnpm cli <command>`).
 *
 * A single entry point for the quick operations a project developer or admin
 * needs against a local/self-hosted deployment: inspect users, tools, profiles
 * and sessions; seed/reset the database; mint API clients; health-check a fresh
 * clone; and chat with the agent. Most commands run in-process against the DB +
 * registries (no running server required); `chat` is the exception (it talks to
 * a running API over HTTP).
 *
 *   pnpm cli <command> [subcommand] [args] [--flags]
 *   pnpm cli --help               the getting-started guide (also: pnpm run help;
 *                                 bare `pnpm help` is pnpm's own built-in)
 *
 * Each command lives in ./commands/<command>.ts and exports `run(args)`.
 * Commands are imported lazily so a cheap command (e.g. `tools`) never pays to
 * load the DB, and a broken module can't take down the whole console.
 */

import chalk from 'chalk';
import { PRODUCT_NAME } from '@greenhouse/utils/brand';
import { closeDb } from './commands/shared.js';

const USAGE = `${chalk.bold(`${PRODUCT_NAME} CLI`)} — dev/ops quick operations

${chalk.bold('Usage:')} pnpm cli <command> [subcommand] [args] [--flags]   ${chalk.dim('(guide: pnpm cli --help)')}

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

${chalk.bold('Chat')} ${chalk.dim('(needs a running server: pnpm api)')}
  chat                      Interactive agent chat (--profile <id>, --session <id>, --list)

${chalk.dim('Global: --json (machine output where supported). DB via DATABASE_URL in .env.')}`;

async function dispatch(command: string, rest: string[]): Promise<number> {
  switch (command) {
    case 'users':
    case 'user':
      return (await import('./commands/users.js')).run(rest);
    case 'tools':
    case 'tool':
      return (await import('./commands/tools.js')).run(rest);
    case 'profiles':
    case 'profile':
      return (await import('./commands/profiles.js')).run(rest);
    case 'sessions':
    case 'session':
      return (await import('./commands/sessions.js')).run(rest);
    case 'seed':
      return (await import('./commands/seed.js')).run(rest);
    case 'db':
      return (await import('./commands/db.js')).run(rest);
    case 'reset':
      return (await import('./commands/db.js')).run(['reset', ...rest]);
    case 'stats':
    case 'overview':
      return (await import('./commands/db.js')).run(['stats', ...rest]);
    case 'doctor':
    case 'check':
      return (await import('./commands/doctor.js')).run(rest);
    case 'api-client':
    case 'api-clients':
      return (await import('./commands/api-client.js')).run(rest);
    case 'chat':
      return (await import('./chat.js')).run(rest);
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
