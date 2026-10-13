/**
 * Agent computers: one sandbox per Agent, from the sandbox provider, with a home that outlives
 * restarts. Shell commands run as the `agent` user for at most two minutes; longer work runs
 * as a background process (gh-jobs in the image) that survives the API, and wakes its Agent
 * when it ends — or when it is lost because the computer restarted under it.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ComputerJob, ComputerView } from '@greenhouse/contract';
import { agentComputers, computerWatches, getDb, members, newId, type AgentComputer } from '@greenhouse/db';
import type { SandboxClient } from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, forbidden } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';
import type { AgentsService } from '../agents/service.js';
import { effectiveModules } from '../members/service.js';

export const SHELL_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 64 * 1024;
const TOOL_OUTPUT_CHARS = 20_000;
const WATCH_MS = 60_000;
const WATCH_DAYS = 7;
export const IDLE_STOP_MS = 30 * 60_000;

/** The end of long output is usually what matters. */
function tail(text: string, max = TOOL_OUTPUT_CHARS): string {
  return text.length > max ? `…(${text.length - max} earlier characters cut)\n${text.slice(-max)}` : text;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Wakes an Agent in a conversation (the engine's deliver). */
export type Deliver = (
  conversationId: string,
  item: { agentId: string; memberId: string; note: string },
) => Promise<void>;

export function createComputersService(deps: { providers: ProvidersService; agents: AgentsService }) {
  let ticker: NodeJS.Timeout | null = null;

  async function sandbox(memberId: string) {
    const resolved = await deps.providers.resolve('sandbox', { memberId, personal: false });
    if (!resolved) throw new ApiError(503, 'computer_unavailable', 'Agent computers are not set up here.');
    return resolved;
  }

  async function clientFor(row: AgentComputer, memberId: string): Promise<SandboxClient> {
    const resolved = await deps.providers.byId('sandbox', row.providerId, { memberId, personal: false });
    if (!resolved)
      throw new ApiError(503, 'computer_unavailable', 'The sandbox that runs this computer is not available.');
    return resolved.client;
  }

  const setState = (
    id: string,
    state: AgentComputer['state'],
    reason: string | null = null,
    extra: Record<string, unknown> = {},
  ) =>
    getDb()
      .update(agentComputers)
      .set({
        state,
        stateReason: reason,
        version: sql`${agentComputers.version} + 1`,
        updatedAt: sql`now()`,
        ...extra,
      } as never)
      .where(eq(agentComputers.id, id));

  /** The computer of an Agent the member owns, started if it was not running. */
  async function ensure(memberId: string, agentId: string): Promise<{ row: AgentComputer; client: SandboxClient }> {
    const [member] = await getDb().select().from(members).where(eq(members.id, memberId));
    if (!member || !effectiveModules(member.modules).computer) throw forbidden('Computers are turned off for you.');
    const { agent } = await deps.agents.load(memberId, agentId);
    const resolved = await sandbox(memberId);
    await getDb()
      .insert(agentComputers)
      .values({
        id: newId('computer'),
        agentId: agent.id,
        ownerId: agent.ownerId,
        providerId: resolved.instance.id,
        sandboxRef: `gh-cmp-${agent.id.toLowerCase()}`,
        timezone: member.timezone,
      })
      .onConflictDoNothing();
    const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.agentId, agent.id));
    const client = row!.providerId === resolved.instance.id ? resolved.client : await clientFor(row!, memberId);
    if (row!.state !== 'running' || (await client.status(row!.sandboxRef)) !== 'running') {
      await setState(row!.id, 'starting');
      try {
        await client.ensure({
          name: row!.sandboxRef,
          labels: { 'greenhouse.computer': row!.id, 'greenhouse.agent': agent.id, 'greenhouse.owner': agent.ownerId },
          timezone: row!.timezone,
        });
        await setState(row!.id, 'running', null, { lastStartedAt: sql`now()`, lastActiveAt: sql`now()` });
      } catch (error) {
        await setState(row!.id, 'failed', toErrorMessage(error).slice(0, 500));
        throw new ApiError(
          503,
          'computer_failed',
          `The computer could not start: ${toErrorMessage(error).slice(0, 300)}`,
        );
      }
    }
    const [fresh] = await getDb().select().from(agentComputers).where(eq(agentComputers.id, row!.id));
    return { row: fresh!, client };
  }

  async function run(
    memberId: string,
    agentId: string,
    argv: string[],
    options: { timeoutMs?: number; cwd?: string } = {},
  ) {
    const { row, client } = await ensure(memberId, agentId);
    const result = await client.exec(row.sandboxRef, {
      argv,
      user: 'agent',
      ...(options.cwd ? { cwd: options.cwd } : {}),
      timeoutMs: options.timeoutMs ?? SHELL_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_CAP,
    });
    await getDb()
      .update(agentComputers)
      .set({ lastActiveAt: sql`now()` })
      .where(eq(agentComputers.id, row.id));
    return { row, result };
  }

  async function gh<T>(memberId: string, agentId: string, args: string[]): Promise<T> {
    const { result } = await run(memberId, agentId, ['gh-jobs', ...args], { timeoutMs: 30_000 });
    if (result.exitCode === 3) throw new ApiError(404, 'not_found', 'There is no such process.');
    const parsed = result.exitCode === 0 ? parseJson<T>(result.stdout) : null;
    if (parsed === null)
      throw new ApiError(
        502,
        'computer_error',
        (result.stderr || result.stdout).trim().slice(0, 300) || 'The computer did not answer.',
      );
    return parsed;
  }

  const toView = (row: AgentComputer): ComputerView => ({
    agent_id: row.agentId,
    state: row.state,
    state_reason: row.stateReason,
    last_active_at: row.lastActiveAt,
    last_started_at: row.lastStartedAt,
  });

  const service = {
    ensure,

    async view(memberId: string, agentId: string): Promise<ComputerView> {
      const { agent } = await deps.agents.load(memberId, agentId);
      const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.agentId, agent.id));
      return row
        ? toView(row)
        : { agent_id: agent.id, state: 'stopped', state_reason: null, last_active_at: null, last_started_at: null };
    },

    async start(memberId: string, agentId: string): Promise<ComputerView> {
      return toView((await ensure(memberId, agentId)).row);
    },

    async stop(memberId: string, agentId: string): Promise<ComputerView> {
      const { agent } = await deps.agents.load(memberId, agentId);
      const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.agentId, agent.id));
      if (!row) return service.view(memberId, agentId);
      await (await clientFor(row, memberId)).stop(row.sandboxRef);
      await setState(row.id, 'stopped', 'member');
      return service.view(memberId, agentId);
    },

    /** Restarting ends every process; the home stays. */
    async restart(memberId: string, agentId: string): Promise<ComputerView> {
      const { row, client } = await ensure(memberId, agentId);
      await client.restart(row.sandboxRef);
      await setState(row.id, 'running', null, { lastStartedAt: sql`now()` });
      return service.view(memberId, agentId);
    },

    /** A shell command as the Agent, at most two minutes. */
    async shell(memberId: string, agentId: string, command: string, timeoutMs = SHELL_TIMEOUT_MS) {
      const seconds = Math.ceil(Math.min(timeoutMs, SHELL_TIMEOUT_MS) / 1000);
      // The deadline is enforced inside the computer, so a command past it is killed there too
      // (with everything it started, except background processes, which have their own session).
      const { result } = await run(
        memberId,
        agentId,
        ['timeout', '--kill-after=5', String(seconds), 'bash', '-lc', command],
        {
          timeoutMs: seconds * 1000 + 10_000,
          cwd: '/home/agent/work',
        },
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '');
      const timedOut = result.timedOut || result.exitCode === 124 || result.exitCode === 137;
      return { exit_code: result.exitCode, timed_out: timedOut, output: tail(output) };
    },

    async jobs(memberId: string, agentId: string): Promise<ComputerJob[]> {
      return gh<ComputerJob[]>(memberId, agentId, ['list']);
    },

    async startJob(
      memberId: string,
      agentId: string,
      command: string,
      name?: string,
    ): Promise<{ id: string; name: string }> {
      return gh(memberId, agentId, ['start', ...(name ? ['--name', name] : []), '--', command]);
    },

    async jobLog(memberId: string, agentId: string, jobId: string, lines = 200): Promise<string> {
      const { result } = await run(
        memberId,
        agentId,
        ['gh-jobs', 'log', jobId, '--lines', String(Math.min(Math.max(lines, 1), 2000))],
        {
          timeoutMs: 30_000,
        },
      );
      if (result.exitCode === 3) throw new ApiError(404, 'not_found', 'There is no such process.');
      return tail(result.stdout);
    },

    async stopJob(memberId: string, agentId: string, jobId: string) {
      return gh<{ id: string; stopped: boolean }>(memberId, agentId, ['stop', jobId]);
    },

    /** The Agent is woken in this conversation when the process ends. */
    async watch(input: { memberId: string; agentId: string; conversationId: string; jobRef: string; name: string }) {
      const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.agentId, input.agentId));
      if (!row) return;
      await getDb()
        .insert(computerWatches)
        .values({
          id: newId('computerWatch'),
          computerId: row.id,
          agentId: input.agentId,
          memberId: input.memberId,
          conversationId: input.conversationId,
          jobRef: input.jobRef,
          name: input.name,
        })
        .onConflictDoNothing();
    },

    /**
     * Wakes Agents whose watched processes ended. Only running computers are asked (a stopped
     * one is not woken to answer); each ended process is claimed once, whatever the number of
     * API processes.
     */
    async checkWatches(deliver: Deliver) {
      await getDb()
        .update(computerWatches)
        .set({ status: 'gone', updatedAt: sql`now()` })
        .where(
          and(
            eq(computerWatches.status, 'watching'),
            lt(computerWatches.createdAt, new Date(Date.now() - WATCH_DAYS * 86_400_000).toISOString()),
          ),
        );
      const watches = await getDb().select().from(computerWatches).where(eq(computerWatches.status, 'watching'));
      const byComputer = new Map<string, typeof watches>();
      for (const watch of watches)
        byComputer.set(watch.computerId, [...(byComputer.get(watch.computerId) ?? []), watch]);
      if (!byComputer.size) return;
      const computers = await getDb()
        .select()
        .from(agentComputers)
        .where(inArray(agentComputers.id, [...byComputer.keys()]));
      for (const computer of computers) {
        try {
          const client = await clientFor(computer, computer.ownerId);
          if ((await client.status(computer.sandboxRef)) !== 'running') continue;
          const listed = await client.exec(computer.sandboxRef, {
            argv: ['gh-jobs', 'list'],
            user: 'agent',
            timeoutMs: 30_000,
          });
          const jobs = listed.exitCode === 0 ? (parseJson<ComputerJob[]>(listed.stdout) ?? []) : null;
          if (!jobs) continue;
          for (const watch of byComputer.get(computer.id) ?? []) {
            const job = jobs.find((entry) => entry.id === watch.jobRef);
            if (job?.status === 'running') continue;
            const [claimed] = await getDb()
              .update(computerWatches)
              .set({ status: 'notified', updatedAt: sql`now()` })
              .where(and(eq(computerWatches.id, watch.id), eq(computerWatches.status, 'watching')))
              .returning();
            if (!claimed) continue;
            const label = watch.name || watch.jobRef;
            const note = !job
              ? `The background process "${label}" (${watch.jobRef}) is no longer listed on your computer.`
              : job.status === 'exited'
                ? `The background process "${label}" (${watch.jobRef}) ended with exit code ${job.exit_code}. Read its output with process_log and tell the member the result.`
                : `The background process "${label}" (${watch.jobRef}) was lost: your computer restarted while it ran. Your files are kept; if the command can resume from what it already wrote, start it again with run_background.`;
            await deliver(watch.conversationId, { agentId: watch.agentId, memberId: watch.memberId, note });
          }
        } catch (error) {
          logger.warn('[computers] could not check processes', { computer: computer.id, error: toErrorMessage(error) });
        }
      }
    },

    /** Computers left idle stop; one with a running process never does. */
    async stopIdle(): Promise<void> {
      const idle = await getDb()
        .select()
        .from(agentComputers)
        .where(
          and(
            eq(agentComputers.state, 'running'),
            lt(agentComputers.lastActiveAt, new Date(Date.now() - IDLE_STOP_MS).toISOString()),
          ),
        );
      for (const computer of idle) {
        try {
          const client = await clientFor(computer, computer.ownerId);
          const listed = await client.exec(computer.sandboxRef, {
            argv: ['gh-jobs', 'running'],
            user: 'agent',
            timeoutMs: 30_000,
          });
          // Not knowing is not the same as none running: keep it up.
          if (listed.exitCode !== 0 || Number(listed.stdout.trim()) > 0) continue;
          await client.stop(computer.sandboxRef);
          await setState(computer.id, 'stopped', 'idle');
        } catch (error) {
          logger.warn('[computers] could not stop an idle computer', {
            computer: computer.id,
            error: toErrorMessage(error),
          });
        }
      }
    },

    /** Checks watched processes and idle computers every minute. */
    startWatching(deliver: Deliver) {
      ticker ??= setInterval(() => {
        void service.checkWatches(deliver).then(() => service.stopIdle());
      }, WATCH_MS);
    },

    stopWatching() {
      if (ticker) clearInterval(ticker);
      ticker = null;
    },
  };
  return service;
}

export type ComputersService = ReturnType<typeof createComputersService>;
