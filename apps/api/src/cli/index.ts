/**
 * `cli` — the greenhouse dev/ops console (`pnpm cli <command>`).
 *
 * A single entry point for the quick operations a developer or admin needs
 * against a local or internal dev deployment: inspect users, tools, profiles and sessions;
 * reset the local database; health-check a fresh clone; and
 * chat with the agent. Most commands run in-process against the DB + registries
 * (no running server required); `chat` is the exception (it talks to a running
 * API over HTTP).
 *
 *   pnpm cli <command> [subcommand] [args] [--flags]
 *   pnpm cli --help               the getting-started guide
 *
 * Commands live in ./commands/<command>.ts and export `run(args)`. The
 * HTTP-driven `chat` script keeps its own argv contract and is delegated to as
 * a child process — its file remains directly runnable too.
 * Commands are imported lazily so a cheap command never pays to load the DB.
 */

import { extensionCommands } from '../extensions/boot.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
import { closeDb } from './commands/shared.js';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));

const CORE_USAGE = `${chalk.bold('greenhouse CLI')} — dev/ops quick operations

${chalk.bold('Usage:')} pnpm cli <command> [subcommand] [args] [--flags]   ${chalk.dim('(guide: pnpm cli --help)')}

${chalk.bold('Inspect')}
  users [list]              List users (--role <r>, --json)
  users show <id|email>     Show one user + their session count
  tools [list]              List agent tools + summaries (--category <c>, --json)
  profiles [list]           List built-in + custom agent profiles (--json)
  sessions [list]           Recent sessions (--user, --channel, --status, --limit, --json)
  sessions show <id>        Session detail + full transcript (--verbose, --json)
  plugins list / status     Compiled plugins, enablement, migrations and boot facts (--json)
  plugins drop <id> --yes   Drop a disabled plugin’s tables and lane rows
  stats                     One-glance row counts + DB health (--json)

${chalk.bold('Manage')}
  users create              Create a user (--email --password --nickname --role)
  db reset                  Wipe ALL data — truncate every table (--yes; local dev only)
  db migrate                Apply the 3.0 migration chain (refuses a 1.x / 2.x database)
  migrate-from-1x           Carry a 1.6 database into a new 3.0 one (--from <url> --to <url> [--dry-run] [--json])
  db baseline               Adopt an existing database: record the migration chain as applied (--dry-run, --yes)
  platform bootstrap        Synchronize system roles / baseline policies with the manifests
  platform create-app <id>  Scaffold a fail-closed Platform app (--title, --output, --dry-run)
  seed                      Load the example dataset from data/examples (--reset | --keep)

${chalk.bold('Diagnose')}
  doctor                    Check env + DB readiness for this deployment

${chalk.bold('Chat')} ${chalk.dim('(needs a running server: pnpm api)')}
  chat                      Interactive agent chat (requires GREENHOUSE_ACCESS_TOKEN)

${chalk.dim('Global: --json (machine output where supported). DB via DATABASE_URL in .env.')}`;

/** Core usage plus one line per command contributed by active extensions. */
function usage(): string {
  const extra = extensionCommands();
  if (extra.length === 0) return CORE_USAGE;
  const lines = extra.map((cmd) => `  ${cmd.name.padEnd(25)} ${cmd.usage}`);
  return `${CORE_USAGE}\n\n${chalk.bold('Extensions')}\n${lines.join('\n')}`;
}

/** Delegate to an operational self-running script, preserving its argv contract. */
function delegate(script: string, args: string[]): Promise<number> {
  const tsx = resolve(CLI_DIR, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
  return new Promise((resolvePromise) => {
    const child = spawn(tsx, [resolve(CLI_DIR, script), ...args], { stdio: 'inherit' });
    child.on('close', (code) => resolvePromise(code ?? 1));
    child.on('error', (err) => {
      console.error(chalk.red('Failed to launch:'), err.message);
      resolvePromise(1);
    });
  });
}

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
    case 'plugins':
      return (await import('./commands/plugins.js')).run(rest);
    case 'platform':
      return (await import('./commands/platform.js')).run(rest);
    case 'seed':
      return (await import('./commands/seed.js')).run(rest);
    case 'migrate-from-1x':
      return (await import('./commands/migrate-from-1x.js')).run(rest);
    // ── HTTP-driven scripts (child-process delegation) ──
    case 'chat':
      return delegate('chat.ts', rest);
    default: {
      const extension = extensionCommands().find((cmd) => cmd.name === command);
      if (extension) {
        // Extension commands get a ready database, like every core command.
        const { openDb, closeDb } = await import('./commands/shared.js');
        await openDb();
        try {
          return await extension.run(rest);
        } finally {
          await closeDb();
        }
      }
      console.error(chalk.red(`Unknown command: ${command}`));
      console.log('\n' + usage());
      return 1;
    }
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
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
