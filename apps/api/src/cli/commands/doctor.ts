/**
 * `admin doctor` — is this deployment ready to run?
 *
 * Checks the things a fresh clone or a new self-host gets wrong: env present,
 * Postgres reachable, schema migrated, a super admin exists, and the fail-closed
 * auth secret is set. Exits non-zero if any critical check fails (warnings don't
 * fail the run). No mutations.
 */

import chalk from 'chalk';
import { initDatabase, getDb } from '@greenhouse/db';
import { DATABASE_URL, dbName, redactDbUrl, heading, dim } from './shared.js';

interface Check {
  label: string;
  ok: boolean;
  warn?: boolean; // a failed warn is advisory, not a hard failure
  detail?: string;
  fix?: string;
}

export async function run(_args: string[]): Promise<number> {
  const checks: Check[] = [];

  checks.push({
    label: 'DATABASE_URL set',
    ok: !!process.env.DATABASE_URL,
    detail: process.env.DATABASE_URL ? redactDbUrl() : dim('using built-in default'),
    fix: 'Set DATABASE_URL in .env',
  });

  // Reachability + migration state are learned from one initDatabase attempt:
  // it connects and then fail-fasts with "tables not found" on an unmigrated DB.
  let reachable = false;
  let migrated = false;
  try {
    await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });
    reachable = true;
    migrated = true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/tables not found/i.test(msg)) {
      reachable = true; // connected, just not migrated
    }
  }
  checks.push({
    label: 'Database reachable',
    ok: reachable,
    detail: reachable ? dbName() : 'connection failed',
    fix: 'Start Postgres and check DATABASE_URL host/port/credentials',
  });
  checks.push({
    label: 'Schema migrated',
    ok: migrated,
    detail: migrated ? undefined : 'tables missing',
    fix: 'Run: npx drizzle-kit migrate',
  });

  let superAdmins = 0;
  if (migrated) {
    try {
      superAdmins = (await getDb().users.list()).filter((u) => u.role === 'super').length;
    } catch {
      /* leave at 0 */
    }
  }
  checks.push({
    label: 'Super admin exists',
    ok: superAdmins > 0,
    detail: `${superAdmins} found`,
    fix: 'Run: pnpm cli users create --role super',
  });

  const signKey = process.env.TOKEN_SIGNING_KEY ?? '';
  checks.push({
    label: 'TOKEN_SIGNING_KEY set',
    ok: signKey.length >= 16,
    detail: signKey ? `${signKey.length} chars` : 'missing',
    fix: 'Set a strong TOKEN_SIGNING_KEY in .env — auth is fail-closed without it',
  });

  const llmKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? '';
  checks.push({
    label: 'LLM API key set',
    ok: !!llmKey,
    warn: true, // agent/chat needs it, but the app boots without it
    detail: llmKey ? 'present' : 'missing',
    fix: 'Set OPENAI_API_KEY in .env for chat/agent features',
  });

  console.log(heading(`${dbName()} — doctor`));
  let hardFail = false;
  for (const c of checks) {
    const icon = c.ok ? chalk.green('✓') : c.warn ? chalk.yellow('⚠') : chalk.red('✗');
    if (!c.ok && !c.warn) hardFail = true;
    console.log(`${icon} ${c.label}${c.detail ? dim(`  ${c.detail}`) : ''}`);
    if (!c.ok) console.log(dim(`    ↳ ${c.fix}`));
  }

  console.log('');
  if (hardFail) {
    console.log(chalk.red('Some critical checks failed — see fixes above.'));
    return 1;
  }
  console.log(chalk.green('All critical checks passed.'));
  return 0;
}
