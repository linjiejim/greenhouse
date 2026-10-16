/**
 * The long-run probe at full length (roadmap M0.6): a job counts one step a second for
 * --minutes, checkpointing to the persistent home; at --restart-at minutes the container is
 * restarted, the job must show as lost, and a new job must resume from the checkpoint and
 * finish. Needs Docker and the computer image.
 *
 *   node --import tsx scripts/computer-probe.mts --minutes 62 --restart-at 30
 */

import { parseArgs } from 'node:util';
import { createDockerSandbox, volumeOf } from '../packages/providers/src/sandbox/docker.ts';

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '62' },
    'restart-at': { type: 'string', default: '30' },
    image: { type: 'string', default: 'greenhouse/bot-computer:latest' },
    runtime: { type: 'string', default: 'runc' },
  },
});
const minutes = Number(values.minutes);
const restartAt = Number(values['restart-at']);
const steps = Math.round(minutes * 60);
const sandbox = createDockerSandbox({
  image: values.image!,
  runtime: values.runtime as 'runc' | 'runsc',
  network: 'bridge',
  memory: '2g',
  cpus: '2',
});
const name = `gh-cmp-probe-${Date.now().toString(36)}`;
const started = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - started) / 60_000).toFixed(1)} min] ${line}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PROBE = [
  'n=$(cat ~/work/probe.state 2>/dev/null || echo 0)',
  'echo "resume from $n"',
  `while [ "$n" -lt ${steps} ]; do n=$((n+1)); echo "$n" > ~/work/probe.state; sleep 1; done`,
  'echo done',
].join('; ');

async function agent(argv: string[]) {
  const result = await sandbox.exec(name, { argv, user: 'agent', timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function jobs(): Promise<Array<{ id: string; status: string; exit_code: number | null }>> {
  return JSON.parse(await agent(['gh-jobs', 'list'])) as never;
}

async function waitFor(id: string, until: number) {
  for (;;) {
    const job = (await jobs()).find((entry) => entry.id === id);
    if (!job || job.status !== 'running' || Date.now() >= until) return job;
    await sleep(15_000);
  }
}

try {
  await sandbox.ensure({ name, labels: { 'greenhouse.probe': 'true' }, timezone: 'Asia/Shanghai' });
  log(`computer ${name} running; job of ${steps} steps (${minutes} min), restart at ${restartAt} min`);
  const first = JSON.parse(await agent(['gh-jobs', 'start', '--name', 'probe', '--', PROBE])) as { id: string };
  const atRestart = await waitFor(first.id, started + restartAt * 60_000);
  const reached = Number(await agent(['cat', '/home/agent/work/probe.state']));
  log(`before the restart: job ${atRestart?.status}, ${reached} steps done`);
  await sandbox.restart(name);
  await sleep(3000);
  const lost = (await jobs()).find((entry) => entry.id === first.id);
  log(`after the restart: job ${lost?.status}`);
  if (lost?.status !== 'lost') throw new Error('The job should show as lost after the restart.');
  const second = JSON.parse(await agent(['gh-jobs', 'start', '--name', 'probe again', '--', PROBE])) as { id: string };
  const finished = await waitFor(second.id, Date.now() + (minutes + 5) * 60_000);
  const output = await agent(['gh-jobs', 'log', second.id, '--lines', '5']);
  const final = Number(await agent(['cat', '/home/agent/work/probe.state']));
  const resumedFrom = Number(/resume from (\d+)/.exec(output)?.[1] ?? -1);
  log(
    `second job ${finished?.status} (exit ${finished?.exit_code}); resumed from ${resumedFrom}; final ${final}/${steps}`,
  );
  const ok = finished?.status === 'exited' && finished.exit_code === 0 && final === steps && resumedFrom >= reached;
  log(ok ? 'PROBE PASSED' : 'PROBE FAILED');
  process.exitCode = ok ? 0 : 1;
} finally {
  await sandbox.remove(name, { keepHome: false });
  log(`removed ${name} and ${volumeOf(name)}`);
}
