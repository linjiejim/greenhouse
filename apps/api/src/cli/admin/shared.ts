/**
 * Shared helpers for the `admin` dev/ops console (apps/api/src/cli/admin.ts).
 *
 * Everything here is deliberately dependency-light: a tiny flag parser, an
 * ANSI-aware table/kv formatter (chalk is already an api dep), readline prompts,
 * and a single lazily-opened DB provider so any command can `await openDb()`
 * without re-wiring dotenv + initDatabase each time.
 */

import { createInterface } from 'node:readline/promises';
import { config } from 'dotenv';
import chalk from 'chalk';
import { ENV_FILE } from '../../paths.js';
import { initDatabase, getDb, isDbInitialized, type DatabaseProvider } from '@greenhouse/db';

// Load .env once, before any command imports a module that reads env at load time.
config({ path: ENV_FILE });

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';

// ─── Database ────────────────────────────────────────────

let _opened = false;

/**
 * Initialize (once) and return the shared DB provider. `initDatabase` fail-fasts
 * on an unmigrated/unreachable database — commands that want to handle that
 * gracefully (e.g. `doctor`) should call `initDatabase` themselves instead.
 */
export async function openDb(): Promise<DatabaseProvider> {
  if (!_opened) {
    await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });
    _opened = true;
  }
  return getDb();
}

/** Close the shared provider if it was opened. Safe to call unconditionally. */
export async function closeDb(): Promise<void> {
  if (isDbInitialized()) {
    try {
      await getDb().close();
    } catch {
      /* ignore */
    }
  }
  _opened = false;
}

/** The database name from the connection string (used in destructive confirms). */
export function dbName(url = DATABASE_URL): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '(unknown)';
  } catch {
    return '(unknown)';
  }
}

/** Connection string with the password redacted, for display. */
export function redactDbUrl(url = DATABASE_URL): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1****@');
}

// ─── Flag parsing ────────────────────────────────────────

/** Flags that are always boolean — they never consume the next token as a value. */
const BOOLEAN_FLAGS = new Set(['json', 'yes', 'keep', 'reset', 'verbose', 'full', 'help', 'all', 'global']);

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal `--key value` / `--bool` parser. Positionals keep their order. */
export function parseFlags(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function flagNum(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const v = flags[key];
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

/**
 * Split `args` into a leading subcommand (first non-flag token) and the rest.
 * `admin users show <id> --json` → { sub: 'show', rest: ['<id>', '--json'] }.
 */
export function splitSub(args: string[], fallback: string): { sub: string; rest: string[] } {
  if (args[0] && !args[0].startsWith('--')) return { sub: args[0], rest: args.slice(1) };
  return { sub: fallback, rest: args };
}

// ─── Prompts ─────────────────────────────────────────────

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const a = (await prompt(`${question} [y/N] `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/** Require the user to type an exact phrase (used to gate destructive actions). */
export async function confirmExact(question: string, expected: string): Promise<boolean> {
  const a = (await prompt(question)).trim();
  return a === expected;
}

// ─── Formatting ──────────────────────────────────────────

export const dim = chalk.dim;

/** A blank line + a bold section title. */
export function heading(text: string): string {
  return '\n' + chalk.bold(text);
}

// eslint-disable-next-line no-control-regex -- intentionally matches ANSI SGR escape sequences
const ANSI = /\x1B\[[0-9;]*m/g;
const visibleLen = (s: string): number => s.replace(ANSI, '').length;

export function truncate(s: string, max: number): string {
  const plain = s.replace(/\s+/g, ' ').trim();
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}

/** Render an ANSI-aware fixed-width table (cells may contain color codes). */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h) => visibleLen(h));
  for (const row of rows) {
    row.forEach((cell, c) => {
      widths[c] = Math.max(widths[c] ?? 0, visibleLen(cell ?? ''));
    });
  }
  const pad = (s: string, w: number) => (s ?? '') + ' '.repeat(Math.max(0, w - visibleLen(s ?? '')));
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => pad(cell, widths[c] ?? 0))
      .join('  ')
      .replace(/\s+$/, '');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [chalk.bold(line(headers)), chalk.dim(sep), ...rows.map(line)].join('\n');
}

/** Render aligned `key: value` pairs. */
export function kvBlock(pairs: Array<[string, string]>): string {
  const keyWidth = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${chalk.dim((k + ':').padEnd(keyWidth + 1))} ${v}`).join('\n');
}

export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
