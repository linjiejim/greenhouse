#!/usr/bin/env tsx
/**
 * Greenhouse evaluation CLI — run evals from the command line.
 *
 * Usage:
 *   pnpm cli eval run                  Run all enabled test cases
 *   pnpm cli eval run --name "v1.0"    Run with a custom name
 *   pnpm cli eval seed                 Seed initial 30 test cases
 *   pnpm cli eval list                 List datasets
 *   pnpm cli eval runs                 List past runs
 *   pnpm cli eval report <run-id>      Show run results
 */

import { config } from 'dotenv';
import { ENV_FILE } from '../paths.js';

// Load .env
config({ path: ENV_FILE });

import chalk from 'chalk';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';
import { initDatabase, getDb } from '@greenhouse/db';
import { executeRun } from '../eval.js';
import { BATCH_EVAL_JUDGE_PROFILE } from '../llm/tasks/batch-eval-judge.js';
import { SEED_DATASETS } from '@greenhouse/db/seeds/eval-seed';
import { requireCliAccessToken } from './access-token.js';
import { validateAccessToken } from '../auth/token.js';

// Initialize database
await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });

// Graceful shutdown
process.on('SIGINT', async () => {
  await getDb().close();
  process.exit(0);
});

function printBanner() {
  console.log(chalk.green.bold('\n  🧪 Greenhouse Evaluation'));
  console.log(chalk.gray('  ─'.repeat(25)));
}

function printHelp() {
  printBanner();
  console.log(`
  Usage:
    pnpm cli eval run [--name "..."] [--profile <id>]  Run evaluation with all enabled test cases
    pnpm cli eval seed                                 Seed initial 30 test cases into DB
    pnpm cli eval list                                 List all datasets
    pnpm cli eval runs                                 List past eval runs
    pnpm cli eval report <run-id>                      Show detailed results for a run
    pnpm cli eval help                                 Show this help

  Environment for "run":
    GREENHOUSE_ACCESS_TOKEN   Access token for a real, active team/super account
`);
}

// ─── Command: seed ───────────────────────────────────────

async function cmdSeed() {
  printBanner();
  const existing = await getDb().eval.listDatasets();
  if (existing.length > 0) {
    console.log(chalk.yellow(`\n  ⚠️  Already have ${existing.length} datasets. Skipping seed.`));
    console.log(chalk.gray('  Delete existing datasets first if you want to re-seed.\n'));
    return;
  }
  const count = await getDb().eval.importDatasets(SEED_DATASETS);
  console.log(chalk.green(`\n  ✅ Seeded ${count} test cases.\n`));
}

// ─── Command: list ───────────────────────────────────────

async function cmdList() {
  printBanner();
  const datasets = await getDb().eval.listDatasets();
  if (datasets.length === 0) {
    console.log(chalk.gray('\n  No datasets. Run: pnpm cli eval seed\n'));
    return;
  }

  console.log(chalk.gray(`\n  ${datasets.length} datasets:\n`));
  console.log(
    chalk.gray(
      '  ' + '#'.padEnd(4) + 'Cat'.padEnd(16) + 'Diff'.padEnd(8) + 'Lang'.padEnd(6) + 'Neg'.padEnd(5) + 'Question',
    ),
  );
  console.log(chalk.gray('  ' + '─'.repeat(90)));

  for (const ds of datasets) {
    const neg = ds.is_negative ? '✗' : ' ';
    const q = ds.question.length > 55 ? ds.question.slice(0, 55) + '…' : ds.question;
    console.log(
      `  ${String(ds.id).padEnd(4)}${ds.category.padEnd(16)}${ds.difficulty.padEnd(8)}${ds.language.padEnd(6)}${neg.padEnd(5)}${q}`,
    );
  }
  console.log('');
}

// ─── Command: runs ───────────────────────────────────────

async function cmdRuns() {
  printBanner();
  const runs = await getDb().eval.listRuns();
  if (runs.length === 0) {
    console.log(chalk.gray('\n  No runs yet. Start one: pnpm cli eval run\n'));
    return;
  }

  console.log(chalk.gray(`\n  ${runs.length} runs:\n`));
  console.log(
    chalk.gray(
      '  ' +
        'ID'.padEnd(10) +
        'Name'.padEnd(20) +
        'Score'.padEnd(8) +
        'Status'.padEnd(12) +
        'Questions'.padEnd(12) +
        'Date',
    ),
  );
  console.log(chalk.gray('  ' + '─'.repeat(80)));

  for (const run of runs) {
    const id = run.id.slice(0, 8);
    const name = (run.name || '—').slice(0, 18).padEnd(20);
    const score = run.avg_score != null ? run.avg_score.toFixed(1).padEnd(8) : '—'.padEnd(8);
    const status = run.status.padEnd(12);
    const questions = `${run.completed}/${run.total}`.padEnd(12);
    const date = new Date(run.created_at).toLocaleString();

    const color = run.status === 'completed' ? chalk.green : run.status === 'failed' ? chalk.red : chalk.yellow;
    console.log(`  ${id}  ${name}${score}${color(status)}${questions}${chalk.gray(date)}`);
  }
  console.log('');
}

// ─── Command: report ─────────────────────────────────────

async function cmdReport(runId: string) {
  printBanner();

  // Support short IDs
  let run = await getDb().eval.getRun(runId);
  if (!run) {
    const runs = await getDb().eval.listRuns();
    const match = runs.find((r) => r.id.startsWith(runId));
    if (match) run = match;
  }

  if (!run) {
    console.log(chalk.red(`\n  ❌ Run not found: ${runId}\n`));
    return;
  }

  const results = await getDb().eval.getRunResults(run.id);

  console.log(`\n  Run: ${run.id.slice(0, 8)} "${run.name || '—'}"  Status: ${run.status}`);
  console.log(
    `  Model: ${run.model}  Profile: ${run.profile_id ?? 'team'}  Started: ${new Date(run.started_at).toLocaleString()}`,
  );

  if (run.avg_score != null) {
    console.log(chalk.bold(`\n  📊 Summary Scores:`));
    console.log(
      `  Overall: ${colorScore(run.avg_score)}  Accuracy: ${colorScore(run.avg_accuracy)}  Completeness: ${colorScore(run.avg_completeness)}  Relevance: ${colorScore(run.avg_relevance)}  Speed: ${colorScore(run.avg_speed)}`,
    );
  }

  console.log(
    chalk.gray(
      `\n  ${'#'.padEnd(4)}${'Score'.padEnd(7)}${'Acc'.padEnd(6)}${'Comp'.padEnd(6)}${'Ref'.padEnd(6)}${'Spd'.padEnd(6)}${'Time'.padEnd(8)}${'Cat'.padEnd(14)}Question`,
    ),
  );
  console.log(chalk.gray('  ' + '─'.repeat(95)));

  for (const r of results) {
    const id = String(r.dataset_id).padEnd(4);
    const score = r.score_final != null ? colorScore(r.score_final).padEnd(7) : chalk.gray('—').padEnd(7);
    const acc = r.score_accuracy != null ? String(r.score_accuracy).padEnd(6) : '—'.padEnd(6);
    const comp = r.score_completeness != null ? String(r.score_completeness).padEnd(6) : '—'.padEnd(6);
    const ref = r.score_relevance != null ? String(r.score_relevance).padEnd(6) : '—'.padEnd(6);
    const spd = r.score_speed != null ? String(r.score_speed).padEnd(6) : '—'.padEnd(6);
    const time = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s`.padEnd(8) : '—'.padEnd(8);
    const cat = r.category.padEnd(14);
    const q = r.question.length > 45 ? r.question.slice(0, 45) + '…' : r.question;
    const statusIcon = r.status === 'completed' ? '' : r.status === 'error' ? chalk.red(' ✗') : chalk.yellow(' ⏳');

    console.log(`  ${id}${score}${acc}${comp}${ref}${spd}${time}${cat}${q}${statusIcon}`);
  }

  // Show errors if any
  const errors = results.filter((r) => r.status === 'error');
  if (errors.length > 0) {
    console.log(chalk.red(`\n  ❌ ${errors.length} error(s):`));
    for (const e of errors) {
      console.log(chalk.red(`  Q${e.dataset_id}: ${e.error?.slice(0, 80)}`));
    }
  }

  console.log('');
}

function colorScore(score: number | null): string {
  if (score == null) return chalk.gray('—');
  const s = score.toFixed(1);
  if (score >= 8) return chalk.green(s);
  if (score >= 6) return chalk.yellow(s);
  return chalk.red(s);
}

// ─── Command: run ────────────────────────────────────────

async function cmdRun(args: string[]) {
  printBanner();

  const nameIdx = args.indexOf('--name');
  const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

  const profileIdx = args.indexOf('--profile');
  const profileId = profileIdx !== -1 ? args[profileIdx + 1] : 'team';

  const datasets = await getDb().eval.listDatasets({ enabled: true });
  if (datasets.length === 0) {
    console.log(chalk.yellow('\n  ⚠️  No enabled datasets. Run: pnpm cli eval seed\n'));
    return;
  }

  const apiBase = `http://localhost:${process.env.API_PORT ?? '3000'}`;

  // Check API health
  try {
    const healthRes = await fetch(`${apiBase}/health`);
    if (!healthRes.ok) throw new Error('unhealthy');
    console.log(chalk.gray(`\n  API: ${apiBase}`));
  } catch {
    console.log(chalk.red(`\n  ❌ Cannot connect to API at ${apiBase}`));
    console.log(chalk.gray('  Start the server first: pnpm api\n'));
    process.exit(1);
  }

  const judgeProfile = BATCH_EVAL_JUDGE_PROFILE;
  console.log(chalk.gray(`  Judge Model: ${judgeProfile.model.model}`));
  console.log(chalk.gray(`  Judge Provider: ${judgeProfile.model.provider}`));
  console.log(chalk.gray(`  Profile: ${profileId}`));
  console.log(chalk.gray(`  Datasets: ${datasets.length} enabled`));
  console.log(chalk.gray(`  Concurrency: 5`));
  if (name) console.log(chalk.gray(`  Run name: "${name}"`));

  console.log(chalk.bold(`\n  🚀 Starting eval run (${datasets.length} questions)...\n`));

  const startTime = Date.now();

  const accessToken = requireCliAccessToken();
  const actor = validateAccessToken(accessToken);
  if (!actor) throw new Error('GREENHOUSE_ACCESS_TOKEN is invalid or expired');

  const run = await executeRun(getDb().eval, {
    accessToken,
    userId: actor.uid,
    name,
    profileId,
    concurrency: 5,
    apiBase,
    onProgress: (info) => {
      const q = info.question.length > 50 ? info.question.slice(0, 50) + '…' : info.question;
      if (info.error) {
        console.log(chalk.red(`  [${info.completed}/${info.total}] ❌ Q${info.datasetId}: ${info.error.slice(0, 60)}`));
      } else {
        const scoreStr = colorScore(info.score ?? null);
        console.log(`  [${info.completed}/${info.total}] ${scoreStr}  Q${info.datasetId}: ${q}`);
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.bold(`\n  ✅ Run completed in ${elapsed}s`));
  console.log(chalk.bold(`\n  📊 Final Scores:`));
  console.log(`  Overall:      ${colorScore(run.avg_score)}`);
  console.log(`  Accuracy:     ${colorScore(run.avg_accuracy)}`);
  console.log(`  Completeness: ${colorScore(run.avg_completeness)}`);
  console.log(`  Relevance:    ${colorScore(run.avg_relevance)}`);
  console.log(`  Speed:        ${colorScore(run.avg_speed)}`);

  console.log(chalk.gray(`\n  Run ID: ${run.id.slice(0, 8)}...`));
  console.log(chalk.gray(`  View details: pnpm cli eval report ${run.id.slice(0, 8)}`));
  console.log(chalk.gray(`  Or open Web UI → Evaluation tab\n`));
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'run':
      await cmdRun(args);
      break;
    case 'seed':
      await cmdSeed();
      break;
    case 'list':
      await cmdList();
      break;
    case 'runs':
      await cmdRuns();
      break;
    case 'report': {
      const runId = args[0];
      if (!runId) {
        console.error(chalk.red('\n  Usage: pnpm cli eval report <run-id>\n'));
        process.exit(1);
      }
      await cmdReport(runId);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
      break;
  }

  await getDb().close();
}

main().catch(async (err) => {
  console.error(chalk.red(`\n  ❌ Fatal: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  try {
    await getDb().close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
