/**
 * `admin users` — list, inspect, and create users.
 *
 * Absorbs the former `admin-create.ts` (now `admin users create`). Greenhouse
 * roles are `super | team | external`.
 */

import chalk from 'chalk';
import { getProductName } from '@greenhouse/utils/brand';
import type { UserRole } from '@greenhouse/db';
import { hashPassword } from '../../auth/password.js';
import {
  openDb,
  parseFlags,
  flagStr,
  flagBool,
  splitSub,
  prompt,
  table,
  kvBlock,
  heading,
  dim,
  truncate,
} from './shared.js';

const VALID_ROLES: readonly UserRole[] = ['super', 'team', 'external'];

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'list');
  switch (sub) {
    case 'list':
      return list(rest);
    case 'show':
      return show(rest);
    case 'create':
    case 'add':
      return create(rest);
    default:
      console.error(chalk.red(`Unknown users subcommand: ${sub}`));
      console.log('Usage: admin users [list | show <id|email> | create]');
      return 1;
  }
}

async function list(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();
  let users = await db.users.list();
  const role = flagStr(flags, 'role');
  if (role) users = users.filter((u) => u.role === role);
  users.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  if (flagBool(flags, 'json')) {
    console.log(
      JSON.stringify(
        users.map(({ password_hash: _p, ...u }) => u),
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(heading(`Users (${users.length})`));
  if (!users.length) {
    console.log(dim('  (none — run `pnpm cli users create`)'));
    return 0;
  }
  const rows = users.map((u) => [
    u.id.slice(0, 8),
    u.email,
    truncate(u.nickname, 20),
    roleColor(u.role),
    u.status === 'active' ? u.status : chalk.red(u.status),
    u.last_login_at ? u.last_login_at.slice(0, 10) : dim('never'),
    u.created_at.slice(0, 10),
  ]);
  console.log(table(['ID', 'Email', 'Nickname', 'Role', 'Status', 'Last login', 'Created'], rows));

  const byRole = VALID_ROLES.map((r) => `${r}: ${users.filter((u) => u.role === r).length}`);
  console.log('\n' + dim(byRole.join('   ')));
  return 0;
}

async function show(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const ref = positionals[0];
  if (!ref) {
    console.error('Usage: admin users show <id|email>');
    return 1;
  }
  const db = await openDb();
  const user = ref.includes('@') ? await db.users.getByEmail(ref) : await db.users.getById(ref);
  if (!user) {
    console.error(chalk.red(`No user found: ${ref}`));
    return 1;
  }
  const sessions = await db.sessions.list({ userId: user.id, status: 'all', limit: 1000 });

  if (flagBool(flags, 'json')) {
    const { password_hash: _p, ...safe } = user;
    console.log(JSON.stringify({ ...safe, session_count: sessions.length }, null, 2));
    return 0;
  }

  console.log(heading(`User — ${user.nickname}`));
  console.log(
    kvBlock([
      ['ID', user.id],
      ['Email', user.email],
      ['Nickname', user.nickname],
      ['Role', roleColor(user.role)],
      ['Status', user.status === 'active' ? chalk.green('active') : chalk.red(user.status)],
      ['Locale', user.locale],
      ['Daily message limit', String(user.daily_message_limit)],
      ['Monthly token limit', String(user.monthly_token_limit)],
      ['Sessions', String(sessions.length)],
      ['Notes', user.notes ?? dim('—')],
      ['Created', user.created_at],
      ['Updated', user.updated_at],
      ['Last login', user.last_login_at ?? dim('never')],
    ]),
  );
  return 0;
}

async function create(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();

  const roleFlag = (flagStr(flags, 'role') ?? 'super') as UserRole;
  if (!VALID_ROLES.includes(roleFlag)) {
    console.error(chalk.red(`Invalid role: ${roleFlag}. Expected one of: ${VALID_ROLES.join(', ')}`));
    return 1;
  }

  console.log(heading(`${getProductName()} — create ${roleFlag} user`));

  if (roleFlag === 'super') {
    const supers = (await db.users.list()).filter((u) => u.role === 'super');
    if (supers.length > 0) {
      console.log(chalk.yellow(`⚠ ${supers.length} super admin(s) already exist:`));
      for (const u of supers) console.log(dim(`   - ${u.email} (${u.nickname})`));
    }
  }

  let email = flagStr(flags, 'email') ?? '';
  let nickname = flagStr(flags, 'nickname') ?? '';
  let password = flagStr(flags, 'password') ?? '';

  if (!email) email = (await prompt('Email: ')).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(chalk.red('❌ Invalid email format'));
    return 1;
  }
  if (await db.users.getByEmail(email)) {
    console.error(chalk.red(`❌ A user with email "${email}" already exists`));
    return 1;
  }
  if (!nickname) nickname = (await prompt('Nickname: ')).trim();
  if (!nickname) {
    console.error(chalk.red('❌ Nickname is required'));
    return 1;
  }
  if (!password) password = (await prompt('Password (min 8 chars): ')).trim();
  if (password.length < 8) {
    console.error(chalk.red('❌ Password must be at least 8 characters'));
    return 1;
  }

  const password_hash = await hashPassword(password);
  const user = await db.users.create({ email, password_hash, nickname, role: roleFlag });

  console.log(chalk.green(`\n✓ Created ${user.role} user`));
  console.log(
    kvBlock([
      ['ID', user.id],
      ['Email', user.email],
      ['Nickname', user.nickname],
      ['Role', user.role],
    ]),
  );
  console.log(dim('\nLog in at the web UI with these credentials.'));
  return 0;
}

function roleColor(role: string): string {
  if (role === 'super') return chalk.magenta(role);
  if (role === 'team') return chalk.cyan(role);
  return role;
}
