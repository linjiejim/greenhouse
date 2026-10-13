/**
 * The long-run probe (roadmap M0.6 gate), on a real Docker engine: a long command in the
 * Agent's computer outlives the turn and the API process that started it; a container restart
 * loses it, the Agent is woken and starts it again, and it resumes from what it wrote in the
 * persistent home. The same scenario with a 60-minute job is `scripts/computer-probe.ts`.
 *
 * Opt-in: GREENHOUSE_LIVE_DOCKER=1, with the computer image built (apps/bot-computer).
 */

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { agentComputers, computerWatches, getDb, messages } from '@greenhouse/db';
import { runDocker } from '@greenhouse/providers';
import { createTestApp, createTestServices } from '../../../testing.js';
import { scriptedModel, text, textThenTool } from '../../../engine/__tests__/model.js';

const live = process.env.GREENHOUSE_LIVE_DOCKER === '1';
const IMAGE = process.env.GREENHOUSE_COMPUTER_IMAGE ?? 'greenhouse/bot-computer:latest';
const ENV = { SANDBOX_PROVIDER: 'docker', SANDBOX_IMAGE: IMAGE, SANDBOX_DOCKER_RUNTIME: 'runc' };
const STEPS = 20;

/** Counts to STEPS, one step a second, resuming from ~/work/probe.state. */
const PROBE = [
  'n=$(cat ~/work/probe.state 2>/dev/null || echo 0)',
  'echo "resume from $n"',
  `while [ "$n" -lt ${STEPS} ]; do n=$((n+1)); echo "$n" > ~/work/probe.state; echo "step $n"; sleep 1; done`,
  'echo done',
].join('; ');

const sandboxes: string[] = [];
afterAll(async () => {
  for (const name of sandboxes) {
    await runDocker(['rm', '-f', name]);
    await runDocker(['volume', 'rm', '-f', `${name}-home`]);
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)('the long-run probe', () => {
  it('a long job survives the API, is lost on a restart, and resumes from its checkpoint', async () => {
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp(ENV, { languageModel: model.languageModel });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    sandboxes.push(`gh-cmp-${agent.id.toLowerCase()}`);

    // 1. The Agent starts the long job in the background and ends its turn.
    scripts.push(
      textThenTool('Starting it in the background.', 'computer', {
        action: 'run_background',
        command: PROBE,
        name: 'probe',
      }),
    );
    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'run the probe' },
    });
    await app.services.engine.idle();
    const [watch] = await getDb().select().from(computerWatches).where(eq(computerWatches.agentId, agent.id));
    expect(watch).toMatchObject({ status: 'watching', name: 'probe' });

    // 2. It keeps running after the turn; another API process sees the same state.
    await sleep(5000);
    const progress = await app.services.computers.shell(lin.id, agent.id, 'cat ~/work/probe.state');
    const reached = Number(progress.output.trim());
    expect(reached).toBeGreaterThanOrEqual(3);
    expect(reached).toBeLessThan(STEPS);

    // 3. The container restarts under it: the job is lost, and the Agent is woken to start it again.
    await app.services.computers.restart(lin.id, agent.id);
    scripts.push(
      textThenTool('Started it again.', 'computer', { action: 'run_background', command: PROBE, name: 'probe again' }),
    );
    const other = createTestServices(ENV, { languageModel: model.languageModel });
    await other.computers.checkWatches((conversationId, item) => app.services.engine.deliver(conversationId, item));
    await app.services.engine.idle();
    const woken = await getDb().select().from(messages).where(eq(messages.conversationId, main.id));
    expect(woken.map((row) => row.content)).toContain('Started it again.');
    expect(JSON.stringify(model.prompts.at(-1))).toContain('was lost: your computer restarted');

    // 4. It resumes from the checkpoint in the home and finishes.
    const deadline = Date.now() + 60_000;
    let jobs = await app.services.computers.jobs(lin.id, agent.id);
    while (jobs.some((job) => job.name === 'probe again' && job.status === 'running') && Date.now() < deadline) {
      await sleep(1000);
      jobs = await app.services.computers.jobs(lin.id, agent.id);
    }
    const again = jobs.find((job) => job.name === 'probe again')!;
    expect(again).toMatchObject({ status: 'exited', exit_code: 0 });
    const log = await app.services.computers.jobLog(lin.id, agent.id, again.id);
    const resumedFrom = Number(/resume from (\d+)/.exec(log)?.[1]);
    expect(resumedFrom).toBeGreaterThanOrEqual(reached);
    expect(log).not.toContain('step 1\n');
    expect(log.trim().endsWith('done')).toBe(true);
    expect((await app.services.computers.shell(lin.id, agent.id, 'cat ~/work/probe.state')).output.trim()).toBe(
      String(STEPS),
    );

    // 5. Its end wakes the Agent once more, whichever process notices.
    scripts.push(text('The probe finished.'));
    await other.computers.checkWatches((conversationId, item) => app.services.engine.deliver(conversationId, item));
    await app.services.engine.idle();
    const final = await getDb().select().from(messages).where(eq(messages.conversationId, main.id));
    expect(final.at(-1)!.content).toBe('The probe finished.');
    const [computer] = await getDb().select().from(agentComputers).where(eq(agentComputers.agentId, agent.id));
    expect(computer!.state).toBe('running');
  }, 180_000);
});
