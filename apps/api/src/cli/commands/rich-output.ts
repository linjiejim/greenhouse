/**
 * `cli rich-output stats` — how often each model's Rich Output blocks fall back.
 *
 * Scans stored assistant messages (no new table, no runtime instrumentation:
 * every message already carries its model id and its exact text) and runs the
 * same shared parser the clients run. A block counts as `invalid` when a
 * renderer would show it as a plain code block, and as `unterminated` when the
 * turn ended mid-block. Protocol-level only: a Mermaid syntax error is known
 * only to the browser's Mermaid and is not counted
 * (spec docs/specs/20261008-rich-output-foundation.md §8, D6).
 */

import chalk from 'chalk';
import { diagnoseRichOutput, type RichBlockFailure } from '@greenhouse/types/rich-output';
import { openDb, parseFlags, flagStr, flagBool, splitSub, table, heading, dim } from './shared.js';

const PAGE = 500;

interface Tally {
  total: number;
  ok: number;
  invalid: number;
  unterminated: number;
  reasons: Partial<Record<RichBlockFailure, number>>;
}

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'stats');
  if (sub === 'stats') return stats(rest);
  console.error(chalk.red(`Unknown rich-output subcommand: ${sub}`));
  console.log('Usage: cli rich-output stats [--since 30d] [--model <id>] [--json]');
  return 1;
}

/** `30d` / `12h` / an ISO date → ISO timestamp. */
export function parseSince(value: string | undefined, now = new Date()): string {
  const raw = value ?? '30d';
  const relative = /^(\d+)([dh])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const ms = relative[2] === 'd' ? amount * 86_400_000 : amount * 3_600_000;
    return new Date(now.getTime() - ms).toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--since must look like 30d, 12h or an ISO date (got "${raw}")`);
  return parsed.toISOString();
}

/** model → fence → tally, from message texts. Exported for tests. */
export function tallyMessages(
  messages: Array<{ model: string | null; content: string }>,
): Map<string, Map<string, Tally>> {
  const byModel = new Map<string, Map<string, Tally>>();
  for (const message of messages) {
    const model = message.model ?? '(unknown)';
    for (const block of diagnoseRichOutput(message.content)) {
      const fences = byModel.get(model) ?? new Map<string, Tally>();
      byModel.set(model, fences);
      const tally = fences.get(block.fence) ?? { total: 0, ok: 0, invalid: 0, unterminated: 0, reasons: {} };
      fences.set(block.fence, tally);
      tally.total += 1;
      tally[block.outcome] += 1;
      if (block.reason) tally.reasons[block.reason] = (tally.reasons[block.reason] ?? 0) + 1;
    }
  }
  return byModel;
}

async function stats(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  let sinceIso: string;
  try {
    sinceIso = parseSince(flagStr(flags, 'since'));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    return 1;
  }
  const model = flagStr(flags, 'model');
  const db = await openDb();

  const messages: Array<{ model: string | null; content: string }> = [];
  let after: { createdAt: string; id: string } | undefined;
  for (;;) {
    const page = await db.sessions.scanFencedAssistantMessages({ sinceIso, model, after, limit: PAGE });
    messages.push(...page.map((row) => ({ model: row.model, content: row.content })));
    if (page.length < PAGE) break;
    const last = page[page.length - 1]!;
    after = { createdAt: last.created_at, id: last.id };
  }

  const byModel = tallyMessages(messages);
  if (flagBool(flags, 'json')) {
    const out = [...byModel].map(([modelId, fences]) => ({
      model: modelId,
      blocks: [...fences].map(([fence, tally]) => ({ fence, ...tally })),
    }));
    console.log(JSON.stringify({ since: sinceIso, messages: messages.length, models: out }, null, 2));
    return 0;
  }

  console.log(heading(`Rich Output since ${sinceIso.slice(0, 10)} — ${messages.length} messages with fences`));
  if (byModel.size === 0) {
    console.log(dim('No registered blocks in this window.'));
    return 0;
  }
  const rows: string[][] = [];
  for (const [modelId, fences] of [...byModel].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [fence, tally] of [...fences].sort(([a], [b]) => a.localeCompare(b))) {
      const failed = tally.invalid + tally.unterminated;
      const rate = tally.total ? `${((failed / tally.total) * 100).toFixed(1)}%` : '-';
      const reasons = Object.entries(tally.reasons)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(', ');
      rows.push([
        modelId,
        fence,
        String(tally.total),
        String(tally.ok),
        String(tally.invalid),
        String(tally.unterminated),
        failed ? chalk.yellow(rate) : rate,
        reasons || dim('—'),
      ]);
    }
  }
  console.log(table(['model', 'block', 'total', 'ok', 'invalid', 'unterminated', 'fallback', 'reasons'], rows));
  return 0;
}
