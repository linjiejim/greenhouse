/**
 * `admin sessions` — browse sessions and dump a session's transcript.
 *
 * Built for debugging: `list` shows recent sessions with owner + message count;
 * `show <id>` prints session metadata and the full message transcript (accepts
 * a short id prefix). Use `--verbose` to avoid truncating long messages.
 */

import chalk from 'chalk';
import {
  openDb,
  parseFlags,
  flagStr,
  flagNum,
  flagBool,
  splitSub,
  table,
  kvBlock,
  heading,
  dim,
  truncate,
} from './shared.js';

/** The message fields this command renders (structural subset of MessageRow). */
type MessageLike = { input_tokens: number | null; output_tokens: number | null; duration_ms: number | null };

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'list');
  if (sub === 'list') return list(rest);
  if (sub === 'show') return show(rest);
  console.error(chalk.red(`Unknown sessions subcommand: ${sub}`));
  console.log('Usage: admin sessions [list | show <id>]');
  return 1;
}

async function list(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();
  const sessions = await db.sessions.list({
    status: flagStr(flags, 'status'),
    channel: flagStr(flags, 'channel'),
    userId: flagStr(flags, 'user'),
    limit: flagNum(flags, 'limit', 20),
  });

  if (flagBool(flags, 'json')) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }

  const emails = new Map((await db.users.list()).map((u) => [u.id, u.email]));
  const counts = await Promise.all(sessions.map((s) => db.sessions.getMessageCount(s.id)));

  console.log(heading(`Sessions (${sessions.length})`));
  if (!sessions.length) {
    console.log(dim('  (none)'));
    return 0;
  }
  const rows = sessions.map((s, i) => [
    s.id.slice(0, 8),
    s.channel,
    s.profile_id,
    s.user_id ? (emails.get(s.user_id) ?? s.user_id.slice(0, 8)) : dim('anon'),
    String(counts[i]),
    truncate(s.title ?? '(untitled)', 40),
    s.updated_at.slice(0, 16).replace('T', ' '),
  ]);
  console.log(table(['ID', 'Channel', 'Profile', 'User', 'Msgs', 'Title', 'Updated'], rows));
  console.log(dim('\nShow a transcript with: pnpm cli sessions show <id>'));
  return 0;
}

async function show(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const ref = positionals[0];
  if (!ref) {
    console.error('Usage: admin sessions show <id>');
    return 1;
  }
  const db = await openDb();

  let session = await db.sessions.getById(ref);
  if (!session && ref.length < 36) {
    // Allow a short id prefix for convenience.
    const recent = await db.sessions.list({ status: 'all', limit: 2000 });
    const matches = recent.filter((s) => s.id.startsWith(ref));
    if (matches.length > 1) {
      console.error(chalk.red(`Ambiguous id prefix "${ref}" — matches ${matches.length} sessions.`));
      return 1;
    }
    session = matches[0];
  }
  if (!session) {
    console.error(chalk.red(`Session not found: ${ref}`));
    return 1;
  }

  const messages = await db.sessions.getMessages(session.id, { limit: 1000 });

  if (flagBool(flags, 'json')) {
    console.log(JSON.stringify({ session, messages }, null, 2));
    return 0;
  }

  console.log(heading(`Session ${session.id}`));
  console.log(
    kvBlock([
      ['Title', session.title ?? dim('(untitled)')],
      ['Status', session.status],
      ['Channel', session.channel],
      ['Profile', session.profile_id],
      ['User', session.user_id ?? dim('anon')],
      ['Created', session.created_at],
      ['Updated', session.updated_at],
      ['Messages', String(messages.length)],
    ]),
  );

  console.log(heading('Transcript'));
  if (!messages.length) {
    console.log(dim('  (no messages)'));
    return 0;
  }
  const verbose = flagBool(flags, 'verbose') || flagBool(flags, 'full');
  for (const m of messages) {
    const who =
      m.role === 'user'
        ? chalk.cyan.bold('user')
        : m.role === 'assistant'
          ? chalk.green.bold('assistant')
          : chalk.magenta.bold(m.role);
    console.log(`\n${chalk.dim(`#${m.seq}`)} ${who}${tokenNote(m)}`);
    console.log(verbose ? m.content : truncate(m.content, 1200));
    const tools = toolNames(m.pipeline);
    if (tools.length) console.log(dim(`  ⚙ tools: ${tools.join(', ')}`));
  }
  return 0;
}

function tokenNote(m: MessageLike): string {
  if (!m.input_tokens && !m.output_tokens) return '';
  const dur = m.duration_ms ? `, ${m.duration_ms}ms` : '';
  return dim(`  (${m.input_tokens ?? 0}→${m.output_tokens ?? 0} tok${dur})`);
}

/** Best-effort extraction of tool names from a message's serialized pipeline. */
function toolNames(pipeline: string | null): string[] {
  if (!pipeline || pipeline === '[]') return [];
  try {
    const steps = JSON.parse(pipeline) as Array<Record<string, unknown>>;
    const names = steps
      .map((s) => (s.tool ?? s.name ?? (s.type === 'tool' ? s.id : undefined)) as string | undefined)
      .filter((n): n is string => typeof n === 'string');
    return [...new Set(names)];
  } catch {
    return [];
  }
}
