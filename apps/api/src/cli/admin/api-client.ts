/**
 * `admin api-client` — mint/rotate and list external API clients.
 *
 *   pnpm admin api-client create [app_id] [app_name] [--profiles a,b]
 *   pnpm admin api-client list [--json]
 *
 * The raw key (gh_sk_…) is printed exactly once on create/rotate — save it.
 * Absorbs the former `create-api-client.ts`.
 */

import chalk from 'chalk';
import { generateApiKey } from '../../auth/api-key.js';
import { openDb, parseFlags, flagStr, flagBool, splitSub, table, heading, dim } from './shared.js';

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'list');
  if (sub === 'create') return create(rest);
  if (sub === 'list') return list(rest);
  console.error(chalk.red(`Unknown api-client subcommand: ${sub} (expected: create | list)`));
  return 1;
}

async function create(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const appId = positionals[0] ?? 'greenhouse-app';
  const appName = positionals[1] ?? 'Greenhouse App';
  const profiles = (flagStr(flags, 'profiles') ?? 'default')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const db = await openDb();
  const { raw, hash } = generateApiKey();

  const existing = await db.apiClients.getByAppId(appId);
  if (existing) {
    await db.apiClients.update(existing.id, { api_key_hash: hash });
    console.log(chalk.yellow(`↻ rotated key for "${appId}" (id=${existing.id})`));
  } else {
    const client = await db.apiClients.create({
      app_id: appId,
      app_name: appName,
      api_key_hash: hash,
      allowed_profiles: profiles,
    });
    console.log(chalk.green(`✓ created client "${appId}" (id=${client.id}), profiles: ${profiles.join(', ')}`));
  }

  console.log(heading('API key — shown once, save it now'));
  console.log('  ' + chalk.bold(raw));
  return 0;
}

async function list(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();
  const clients = await db.apiClients.list();

  if (flagBool(flags, 'json')) {
    console.log(JSON.stringify(clients, null, 2));
    return 0;
  }

  console.log(heading(`API clients (${clients.length})`));
  if (!clients.length) {
    console.log(dim('  (none — create one with: pnpm admin api-client create)'));
    return 0;
  }
  console.log(
    table(
      ['ID', 'App ID', 'Name', 'Profiles', 'Created'],
      clients.map((c) => [
        String(c.id).slice(0, 8),
        c.app_id,
        c.app_name,
        formatProfiles(c.allowed_profiles),
        typeof c.created_at === 'string' ? c.created_at.slice(0, 10) : '',
      ]),
    ),
  );
  return 0;
}

/** `allowed_profiles` is stored as a JSON text column — parse it for display. */
function formatProfiles(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.join(',') : String(raw);
  } catch {
    return String(raw ?? '');
  }
}
