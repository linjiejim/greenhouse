/**
 * Agent computers: one sandbox per Agent and member, from the sandbox provider, with a home that
 * outlives restarts. The owner has the Agent's own computer; when a public Agent's publication
 * grants one, each member who uses it gets their own copy, so nobody sees another's files.
 * Shell commands run as the `agent` user for at most two minutes; longer work runs as a
 * background process (gh-jobs in the image) that survives the API, and wakes its Agent when it
 * ends — or when it is lost because the computer restarted under it.
 *
 * People reach a computer only as the member whose computer it is: its screen and terminal
 * through one-time tickets (realtime/computer.ts), its home through the file routes. A pending
 * take-over or sign-in card keeps it awake, so the page the Agent needed help with is still there.
 *
 * The screen has one controller at a time (the lease columns): a member's control screen holds
 * it while open and always wins; the Agent's browser (browser.ts) holds it for one action at a
 * time, and only when nobody else does.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  AdminComputers,
  ComputerCapacity,
  ComputerFile,
  ComputerFolder,
  ComputerJob,
  ComputerTicket,
  ComputerTicketPurpose,
  ComputerView,
} from '@greenhouse/contract';
import {
  agentComputers,
  agents as agentRows,
  computerWatches,
  getDb,
  idempotencyKeys,
  members,
  newId,
  requests,
  runs,
  transaction,
  type AgentComputer,
  type Agent as AgentRow,
} from '@greenhouse/db';
import type { SandboxClient, SandboxStream } from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { audit } from '../../audit.js';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';
import type { Hub } from '../../realtime/hub.js';
import type { AgentsService } from '../agents/service.js';
import { MAX_UPLOAD_BYTES } from '../files/service.js';
import { effectiveModules } from '../members/service.js';
import {
  AGENT_HOME,
  DELETE_SCRIPT,
  DOWNLOAD_MAX_BYTES,
  DOWNLOAD_SCRIPT,
  homePath,
  LIST_MAX_ENTRIES,
  LIST_SCRIPT,
  parseListing,
  parseUploaded,
  scriptArgv,
  scriptError,
  UPLOAD_SCRIPT,
  uploadName,
} from './files.js';
import { bodyOf, readSizeLine, runToEnd } from './streams.js';
import { createComputerBackups } from './backups.js';
import { TERMINAL_ARGV, TERMINAL_CWD } from './terminal.js';

export const SHELL_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 64 * 1024;
const TOOL_OUTPUT_CHARS = 20_000;
const WATCH_MS = 60_000;
const WATCH_DAYS = 7;
/** Capacity when an admin set none: stop after 30 idle minutes, no limit on running computers. */
const CAPACITY: ComputerCapacity = { idle_minutes: 30, max_running: 0 };
/** A ticket is spent within a minute or never. */
const TICKET_TTL_MS = 60_000;
/** Tickets live in the replay table under this scope, as keyed hashes only. */
const TICKETS = 'computer_ticket';
/** A file transfer still running after this long is cut. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/** A member's hold on the screen lapses this long after their control socket last renewed it. */
export const CONTROL_LEASE_MS = 60_000;

/** What a ticket grants, stored with its hash. */
interface TicketGrant {
  member_id: string;
  computer_id: string;
  purpose: ComputerTicketPurpose;
  /** The member's sign-in generation when it was made: a password change spends it. */
  auth_version: number;
}

/** A socket's way into a computer, from a spent ticket (realtime/computer.ts). */
export interface ComputerSession {
  memberId: string;
  agentId: string;
  purpose: ComputerTicketPurpose;
  /** The screen (RFB) or the terminal (gh-term frames in, output out). */
  stream: SandboxStream;
  /** Activity: the idle stop leaves a computer alone while someone watches or types. */
  touch(): Promise<void>;
  /** Whether the member may still use it: active, the same sign-in, computers on. */
  allowed(): Promise<boolean>;
  /** A `control` screen holds the screen for the member: renew it while open, release it on close. */
  control?: { renew(): Promise<void>; release(): Promise<void> };
}

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
  item: { agentId: string; memberId: string; note: string; kind?: 'event'; dedupeKey?: string; computer?: boolean },
) => Promise<void>;

export function createComputersService(deps: {
  encryptionKey: Buffer;
  providers: ProvidersService;
  agents: AgentsService;
  hub: Hub;
  /** Ticket secrets: random, and the keyed hash they are stored as. */
  secrets: { create(): string; hash(secret: string): string };
}) {
  const backups = createComputerBackups(deps);
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

  /** Records a state change and tells the member whose computer it is; their sockets close on a stop. */
  async function setState(
    id: string,
    state: AgentComputer['state'],
    reason: string | null = null,
    extra: Record<string, unknown> = {},
  ) {
    const [row] = await getDb()
      .update(agentComputers)
      .set({
        state,
        stateReason: reason,
        version: sql`${agentComputers.version} + 1`,
        updatedAt: sql`now()`,
        ...extra,
      } as never)
      .where(eq(agentComputers.id, id))
      .returning({ agentId: agentComputers.agentId, ownerId: agentComputers.ownerId });
    if (row) deps.hub.publish([row.ownerId], { type: 'computer.updated', data: { agent_id: row.agentId, state } });
  }

  const touch = async (id: string) => {
    await getDb()
      .update(agentComputers)
      .set({ lastActiveAt: sql`now()` })
      .where(eq(agentComputers.id, id));
  };

  /** Stored with the sandbox capability's defaults (provider_bindings), else the defaults above. */
  async function capacity(): Promise<ComputerCapacity> {
    const stored = await deps.providers.defaultsOf('sandbox');
    const idle = Number(stored.idle_minutes);
    const max = Number(stored.max_running);
    return {
      idle_minutes: Number.isInteger(idle) && idle >= 5 ? idle : CAPACITY.idle_minutes,
      max_running: Number.isInteger(max) && max >= 0 ? max : CAPACITY.max_running,
    };
  }

  /** A computer by id, for an admin. */
  async function byId(id: string): Promise<AgentComputer> {
    const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.id, id));
    if (!row) throw notFound('Computer');
    return row;
  }

  /** The member, when computers are on for them. */
  async function computerMember(memberId: string) {
    const [member] = await getDb().select().from(members).where(eq(members.id, memberId));
    if (!member || member.status !== 'active' || !effectiveModules(member.modules).computer)
      throw forbidden('Computers are turned off for you.');
    return member;
  }

  async function stillAllowed(grant: TicketGrant): Promise<boolean> {
    const [member] = await getDb()
      .select({ status: members.status, authVersion: members.authVersion, modules: members.modules })
      .from(members)
      .where(eq(members.id, grant.member_id));
    return (
      member?.status === 'active' &&
      member.authVersion === grant.auth_version &&
      effectiveModules(member.modules).computer === true
    );
  }

  /** The Agent whose computer the member uses: their own, or a public one that grants them a copy. */
  async function agentFor(memberId: string, agentId: string): Promise<AgentRow> {
    const own = await deps.agents.findOwn(memberId, agentId);
    if (own) return own;
    const usable = await deps.agents.openPublic(memberId, agentId);
    if (!usable) throw notFound('Agent');
    if (usable.agent.publication.computer !== true) throw forbidden('This Agent does not come with a computer.');
    return usable.agent;
  }

  /** The member's computer for an Agent (theirs, or their copy of a public one), if it was ever made. */
  async function rowOf(memberId: string, agentId: string): Promise<AgentComputer | undefined> {
    const [row] = await getDb()
      .select()
      .from(agentComputers)
      .where(and(eq(agentComputers.agentId, agentId), eq(agentComputers.ownerId, memberId)));
    return row;
  }

  /** The member's computer for an Agent, started if it was not running. */
  async function ensure(memberId: string, agentId: string): Promise<{ row: AgentComputer; client: SandboxClient }> {
    const member = await computerMember(memberId);
    const agent = await agentFor(memberId, agentId);
    const resolved = await sandbox(memberId);
    const id = newId('computer');
    await getDb()
      .insert(agentComputers)
      .values({
        id,
        agentId: agent.id,
        ownerId: memberId,
        providerId: resolved.instance.id,
        // The owner's computer is named after the Agent; a member's copy after its own row.
        sandboxRef: `gh-cmp-${(agent.ownerId === memberId ? agent.id : id).toLowerCase()}`,
        timezone: member.timezone,
      })
      .onConflictDoNothing();
    const row = await rowOf(memberId, agent.id);
    const client = row!.providerId === resolved.instance.id ? resolved.client : await clientFor(row!, memberId);
    if (row!.state !== 'running' || (await client.status(row!.sandboxRef)) !== 'running') {
      const claimed = await transaction(async () => {
        await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${row!.id}))`);
        await getDb().execute(sql`select pg_advisory_xact_lock(704012)`);
        const current = await byId(row!.id);
        if (current.state === 'starting') throw conflict('computer_starting', 'The computer is starting.');
        const { max_running: max } = await capacity();
        const [busy] = await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(agentComputers)
          .where(and(inArray(agentComputers.state, ['running', 'starting']), ne(agentComputers.id, row!.id)));
        const [first] = await getDb()
          .select()
          .from(agentComputers)
          .where(eq(agentComputers.state, 'queued'))
          .orderBy(agentComputers.queuedAt, agentComputers.id)
          .limit(1);
        if ((max > 0 && (busy?.count ?? 0) >= max) || (first && first.id !== row!.id)) {
          if (current.state !== 'queued') await setState(row!.id, 'queued', null, { queuedAt: sql`now()` });
          return false;
        }
        await setState(row!.id, 'starting', null, { queuedAt: null });
        return true;
      });
      if (!claimed) throw conflict('computer_queued', 'The computer is queued until capacity is available.');
      let restoring = false;
      try {
        const lostHome =
          row!.stateReason === 'backup_restore_failed' ||
          (client.homeExists ? !(await client.homeExists(row!.sandboxRef)) : false);
        const latest = lostHome ? (await backups.list(row!.id)).find((b) => b.status === 'complete') : undefined;
        await client.ensure({
          name: row!.sandboxRef,
          labels: { 'greenhouse.computer': row!.id, 'greenhouse.agent': agent.id, 'greenhouse.owner': memberId },
          timezone: row!.timezone,
        });
        if (latest) {
          restoring = true;
          try {
            await backups.restore(row!, client, latest.id);
          } finally {
            await client.restart(row!.sandboxRef);
          }
        }
        await setState(row!.id, 'running', null, { lastStartedAt: sql`now()`, lastActiveAt: sql`now()` });
      } catch (error) {
        await client.stop(row!.sandboxRef).catch(() => undefined);
        await setState(row!.id, 'failed', restoring ? 'backup_restore_failed' : toErrorMessage(error).slice(0, 500));
        throw new ApiError(
          503,
          'computer_failed',
          `The computer could not start: ${toErrorMessage(error).slice(0, 300)}`,
        );
      }
    }
    const [fresh] = await getDb().select().from(agentComputers).where(eq(agentComputers.id, row!.id));
    if (fresh?.backgroundRunId) {
      const [run] = await getDb().select().from(runs).where(eq(runs.id, fresh.backgroundRunId));
      if (!run || !['running', 'waiting', 'queued'].includes(run.status)) {
        throw conflict('computer_background_busy', 'The computer is reserved for background work.');
      }
      if (!client.setEgress)
        throw conflict('background_network_unavailable', 'This sandbox cannot restrict background networking.');
      await client.setEgress(
        fresh.sandboxRef,
        run.checkpoint?.read_private ? [] : ((run.input.domains as string[]) ?? []),
      );
    } else if (fresh?.egressRestricted) {
      await client.setEgress?.(fresh.sandboxRef, null);
      await getDb().update(agentComputers).set({ egressRestricted: false }).where(eq(agentComputers.id, fresh.id));
    }
    return { row: fresh!, client };
  }

  async function run(
    memberId: string,
    agentId: string,
    argv: string[],
    options: { timeoutMs?: number; cwd?: string; maxOutputBytes?: number } = {},
  ) {
    const { row, client } = await ensure(memberId, agentId);
    const result = await client.exec(row.sandboxRef, {
      argv,
      user: 'agent',
      ...(options.cwd ? { cwd: options.cwd } : {}),
      timeoutMs: options.timeoutMs ?? SHELL_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? OUTPUT_CAP,
    });
    await touch(row.id);
    return { row, result };
  }

  /** One of the file scripts (files.ts) in the member's computer; its output, or the error its exit means. */
  async function fileScript(memberId: string, agentId: string, script: string, args: string[]): Promise<string> {
    const { result } = await run(memberId, agentId, scriptArgv(script, args), {
      timeoutMs: 30_000,
      cwd: AGENT_HOME,
      maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) throw scriptError(result.exitCode, result.stderr);
    return result.stdout;
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

  async function queuePosition(id: string) {
    const queue = await getDb()
      .select({ id: agentComputers.id })
      .from(agentComputers)
      .where(eq(agentComputers.state, 'queued'))
      .orderBy(agentComputers.queuedAt, agentComputers.id);
    const index = queue.findIndex((r) => r.id === id);
    return index >= 0 ? index + 1 : null;
  }

  async function admin(actorId: string) {
    const [member] = await getDb().select().from(members).where(eq(members.id, actorId));
    if (member?.role !== 'admin' || member.status !== 'active') throw forbidden('Admin access is required.');
  }

  async function backupBeforeStop(row: AgentComputer, client: SandboxClient) {
    try {
      await backups.take(row, client, false);
    } catch (error) {
      logger.warn('[computers] backup before stop failed', { computer: row.id, error: toErrorMessage(error) });
    }
  }

  async function stopRow(row: AgentComputer, reason: string) {
    await transaction(async () => {
      await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${row.id}))`);
      row = await byId(row.id);
      if (reason === 'idle' && row.state !== 'running') return;
      if (row.state === 'starting') throw conflict('computer_starting', 'Wait for the computer to finish starting.');
      const client = await clientFor(row, row.ownerId);
      if (row.state === 'running') await backupBeforeStop(row, client);
      if (reason === 'idle' && (await byId(row.id)).lastActiveAt !== row.lastActiveAt) return;
      await client.stop(row.sandboxRef);
      await setState(row.id, 'stopped', reason, { queuedAt: null });
    });
    await service.drainQueue();
  }

  const toView = async (row: AgentComputer): Promise<ComputerView> => ({
    queue_position: row.state === 'queued' ? await queuePosition(row.id) : null,
    agent_id: row.agentId,
    state: row.state,
    state_reason: row.stateReason,
    last_active_at: row.lastActiveAt,
    last_started_at: row.lastStartedAt,
  });

  const service = {
    ensure,

    async assertRunAccess(memberId: string, agentId: string, runId: string) {
      await agentFor(memberId, agentId);
      const row = await rowOf(memberId, agentId);
      if (row?.backgroundRunId && row.backgroundRunId !== runId)
        throw conflict('computer_background_busy', 'Another run is using this computer.');
    },

    async reserveBackground(memberId: string, agentId: string, runId: string) {
      const { row, client } = await ensure(memberId, agentId);
      if (!client.setEgress)
        throw conflict('background_network_unavailable', 'This sandbox cannot restrict background networking.');
      if (row.leaseController === 'member' && Date.parse(row.leaseUntil ?? '') > Date.now())
        throw conflict('computer_background_busy', 'The member is controlling this computer.');
      if (
        row.backgroundRunId !== runId &&
        (await service.jobs(memberId, agentId)).some((job) => job.status === 'running')
      )
        throw conflict('computer_background_busy', 'A process is already using this computer.');
      const [reserved] = await getDb()
        .update(agentComputers)
        .set({ backgroundRunId: runId, egressRestricted: true })
        .where(
          and(
            eq(agentComputers.id, row.id),
            or(isNull(agentComputers.backgroundRunId), eq(agentComputers.backgroundRunId, runId)),
          ),
        )
        .returning();
      if (!reserved) throw conflict('computer_background_busy', 'Another background run is using this computer.');
      await ensure(memberId, agentId);
    },
    async sealBackground(memberId: string, agentId: string, runId: string) {
      const row = await rowOf(memberId, agentId);
      if (row?.backgroundRunId !== runId) return;
      const client = await clientFor(row, memberId);
      await client.setEgress?.(row.sandboxRef, []);
    },
    async releaseBackground(memberId: string, agentId: string, runId: string) {
      await transaction(async () => {
        const found = await rowOf(memberId, agentId);
        if (found?.backgroundRunId !== runId) return;
        await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${found.id}))`);
        const row = await byId(found.id);
        if (row.backgroundRunId !== runId) return;
        const client = await clientFor(row, memberId);
        // Stop processes before normal network access can be restored by a later foreground turn.
        await backupBeforeStop(row, client);
        await client.restart(row.sandboxRef);
        await client.stop(row.sandboxRef);
        await getDb()
          .update(agentComputers)
          .set({ backgroundRunId: null })
          .where(and(eq(agentComputers.id, row.id), eq(agentComputers.backgroundRunId, runId)));
        await setState(row.id, 'stopped');
      });
      await service.drainQueue();
    },

    async view(memberId: string, agentId: string): Promise<ComputerView> {
      const agent = await agentFor(memberId, agentId);
      const row = await rowOf(memberId, agent.id);
      return row
        ? toView(row)
        : { agent_id: agent.id, state: 'stopped', state_reason: null, last_active_at: null, last_started_at: null };
    },

    async start(memberId: string, agentId: string): Promise<ComputerView> {
      try {
        return await toView((await ensure(memberId, agentId)).row);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'computer_queued') return service.view(memberId, agentId);
        throw error;
      }
    },

    async stop(memberId: string, agentId: string): Promise<ComputerView> {
      const agent = await agentFor(memberId, agentId);
      const row = await rowOf(memberId, agent.id);
      if (!row) return service.view(memberId, agentId);
      await stopRow(row, 'member');
      return service.view(memberId, agentId);
    },

    /** Restarting ends every process; the home stays. */
    async restart(memberId: string, agentId: string): Promise<ComputerView> {
      const { row, client } = await ensure(memberId, agentId);
      await setState(row.id, 'starting');
      try {
        await client.restart(row.sandboxRef);
      } catch (error) {
        await setState(row.id, 'failed', toErrorMessage(error).slice(0, 500));
        throw new ApiError(
          503,
          'computer_failed',
          `The computer could not restart: ${toErrorMessage(error).slice(0, 300)}`,
        );
      }
      await setState(row.id, 'running', null, { lastStartedAt: sql`now()`, lastActiveAt: sql`now()` });
      return service.view(memberId, agentId);
    },

    /**
     * A one-time ticket for the screen (`view`, `control`) or the terminal of the member's own
     * computer of this Agent. Taking over and the terminal start the computer; watching needs it
     * running. Only its keyed hash is stored, for a minute.
     */
    async ticket(memberId: string, agentId: string, purpose: ComputerTicketPurpose): Promise<ComputerTicket> {
      const member = await computerMember(memberId);
      let row: AgentComputer;
      if (purpose === 'view') {
        const agent = await agentFor(memberId, agentId);
        const found = await rowOf(memberId, agent.id);
        if (
          found?.state !== 'running' ||
          (await (await clientFor(found, memberId)).status(found.sandboxRef)) !== 'running'
        ) {
          throw conflict('computer_not_running', 'The computer is not running. Start it first.');
        }
        row = found;
      } else {
        row = (await ensure(memberId, agentId)).row;
      }
      if (row.backgroundRunId && purpose !== 'view')
        throw conflict('computer_background_busy', 'Background work is using this computer.');
      const ticket = deps.secrets.create();
      const grant: TicketGrant = {
        member_id: memberId,
        computer_id: row.id,
        purpose,
        auth_version: member.authVersion,
      };
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();
      await getDb()
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, TICKETS), lt(idempotencyKeys.expiresAt, now)));
      await getDb()
        .insert(idempotencyKeys)
        .values({
          scope: TICKETS,
          key: deps.secrets.hash(ticket),
          requestHash: purpose,
          status: 'done',
          response: grant,
          expiresAt,
        });
      return { ticket, expires_at: expiresAt };
    },

    /**
     * Spends a ticket on the socket it was made for and opens the stream: the screen for `view`
     * and `control`, the terminal for `terminal`. Refused when the ticket is unknown, spent,
     * expired or for the other socket (ticket_invalid), when its member may no longer use
     * computers (forbidden), or when the computer stopped (computer_not_running).
     */
    async open(ticket: string, socket: 'screen' | 'terminal'): Promise<ComputerSession> {
      const invalid = () => new ApiError(401, 'ticket_invalid', 'This ticket is not valid. Ask for a new one.');
      if (!ticket || ticket.length > 200) throw invalid();
      const [spent] = await getDb()
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, TICKETS),
            eq(idempotencyKeys.key, deps.secrets.hash(ticket)),
            gt(idempotencyKeys.expiresAt, new Date().toISOString()),
          ),
        )
        .returning();
      const grant = spent?.response as TicketGrant | undefined;
      if (!grant || (grant.purpose === 'terminal') !== (socket === 'terminal')) throw invalid();
      const allowed = () => stillAllowed(grant);
      if (!(await allowed())) throw forbidden('You can no longer use this computer.');
      const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.id, grant.computer_id));
      if (row?.state !== 'running') throw conflict('computer_not_running', 'The computer is not running.');
      const client = await clientFor(row, grant.member_id);
      const stream =
        socket === 'screen'
          ? client.screen(row.sandboxRef)
          : client.stream(row.sandboxRef, { argv: TERMINAL_ARGV, user: 'agent', cwd: TERMINAL_CWD });
      await touch(row.id);
      // Taking over the screen takes it from the Agent: its browser waits until this closes.
      let control: ComputerSession['control'];
      if (socket === 'screen' && grant.purpose === 'control') {
        const holder = `ctl_${randomUUID()}`;
        const hold = () => service.claimScreen(row.id, holder, 'member', CONTROL_LEASE_MS).then(() => undefined);
        await hold();
        control = { renew: hold, release: () => service.releaseScreen(row.id, holder) };
      }
      return {
        memberId: grant.member_id,
        agentId: row.agentId,
        purpose: grant.purpose,
        stream,
        touch: () => touch(row.id),
        allowed,
        ...(control ? { control } : {}),
      };
    },

    /**
     * Claims the computer's screen for a holder. The member always gets it (a take-over wins);
     * an Agent action only when nobody holds it, its hold lapsed, or it is the holder already.
     * Refused, it says who holds it.
     */
    async claimScreen(
      computerId: string,
      holder: string,
      who: 'member' | 'agent',
      ttlMs: number,
    ): Promise<'claimed' | 'member' | 'agent'> {
      const now = new Date().toISOString();
      const [claimed] = await getDb()
        .update(agentComputers)
        .set({ leaseController: who, leaseHolder: holder, leaseUntil: new Date(Date.now() + ttlMs).toISOString() })
        .where(
          and(
            eq(agentComputers.id, computerId),
            who === 'member'
              ? undefined
              : or(
                  isNull(agentComputers.leaseUntil),
                  lt(agentComputers.leaseUntil, now),
                  eq(agentComputers.leaseHolder, holder),
                ),
          ),
        )
        .returning({ id: agentComputers.id });
      if (claimed) return 'claimed';
      const [current] = await getDb()
        .select({ controller: agentComputers.leaseController })
        .from(agentComputers)
        .where(eq(agentComputers.id, computerId));
      return current?.controller === 'member' ? 'member' : 'agent';
    },

    /** Whether this holder still has the screen: nobody took it over and the hold has not lapsed. */
    async holdsScreen(computerId: string, holder: string): Promise<boolean> {
      const [row] = await getDb()
        .select({ id: agentComputers.id })
        .from(agentComputers)
        .where(
          and(
            eq(agentComputers.id, computerId),
            eq(agentComputers.leaseHolder, holder),
            gt(agentComputers.leaseUntil, new Date().toISOString()),
          ),
        );
      return !!row;
    },

    /** Lets go of the screen, if this holder still has it. */
    async releaseScreen(computerId: string, holder: string): Promise<void> {
      await getDb()
        .update(agentComputers)
        .set({ leaseController: null, leaseHolder: null, leaseUntil: null })
        .where(and(eq(agentComputers.id, computerId), eq(agentComputers.leaseHolder, holder)));
    },

    /** Counts as activity: the idle stop leaves the computer alone for another half hour. */
    touch: (computerId: string) => touch(computerId),

    /** A folder of the home: folders first, then files, each by name; at most 500. */
    async files(memberId: string, agentId: string, rawPath: string): Promise<ComputerFolder> {
      const path = homePath(rawPath);
      const listing = parseListing(
        await fileScript(memberId, agentId, LIST_SCRIPT, [path.abs, String(LIST_MAX_ENTRIES)]),
      );
      return { path: path.rel, ...listing };
    },

    /** One file of the home, streamed: its name, its exact size and its bytes. */
    async fileContent(memberId: string, agentId: string, rawPath: string) {
      const path = homePath(rawPath);
      if (!path.rel) throw invalidInput('Choose a file.');
      const { row, client } = await ensure(memberId, agentId);
      const stream = client.stream(row.sandboxRef, {
        argv: scriptArgv(DOWNLOAD_SCRIPT, [path.abs, String(DOWNLOAD_MAX_BYTES)]),
        user: 'agent',
        cwd: AGENT_HOME,
      });
      stream.input.end();
      const header = await readSizeLine(stream);
      if ('code' in header) {
        stream.kill();
        throw scriptError(header.code, header.stderr);
      }
      await touch(row.id);
      return {
        name: path.rel.split('/').pop()!,
        size: header.size,
        body: bodyOf(stream, header.size, header.rest, () => void touch(row.id)),
      };
    },

    /** Saves an upload into a folder of the home, under a free name: nothing is overwritten. */
    async upload(
      memberId: string,
      agentId: string,
      rawFolder: string,
      file: { name: string; bytes: Uint8Array },
    ): Promise<ComputerFile> {
      const folder = homePath(rawFolder);
      if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ApiError(413, 'too_large', 'Files can be up to 50 MB.');
      const { base, ext } = uploadName(file.name);
      const { row, client } = await ensure(memberId, agentId);
      const stream = client.stream(row.sandboxRef, {
        argv: scriptArgv(UPLOAD_SCRIPT, [folder.abs, base, ext, String(file.bytes.byteLength)]),
        user: 'agent',
        cwd: AGENT_HOME,
      });
      const result = await runToEnd(stream, file.bytes, { timeoutMs: TRANSFER_TIMEOUT_MS, maxOutputBytes: 4096 });
      await touch(row.id);
      if (result.code !== 0) throw scriptError(result.code, result.stderr);
      const saved = parseUploaded(result.stdout);
      if (!saved) throw new ApiError(502, 'computer_error', 'The computer did not say where it saved the file.');
      return saved;
    },

    /** Deletes a file or a folder with everything in it; the home and the folders the computer needs stay. */
    async removeFile(memberId: string, agentId: string, rawPath: string): Promise<void> {
      const path = homePath(rawPath);
      if (!path.rel) throw invalidInput('The home folder itself cannot be deleted.');
      await fileScript(memberId, agentId, DELETE_SCRIPT, [path.abs]);
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
      const row = await rowOf(input.memberId, input.agentId);
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
            await deliver(watch.conversationId, {
              agentId: watch.agentId,
              memberId: watch.memberId,
              note,
              kind: 'event',
              dedupeKey: `computer-process:${watch.id}`,
              computer: true,
            });
          }
        } catch (error) {
          logger.warn('[computers] could not check processes', { computer: computer.id, error: toErrorMessage(error) });
        }
      }
    },

    /** 管理 → 服务 · 沙箱: every computer, most recently used first, with the capacity. */
    async adminList(actorId: string): Promise<AdminComputers> {
      await admin(actorId);
      const rows = await getDb()
        .select({
          computer: agentComputers,
          agentName: agentRows.name,
          ownerName: members.name,
        })
        .from(agentComputers)
        .innerJoin(agentRows, eq(agentRows.id, agentComputers.agentId))
        .innerJoin(members, eq(members.id, agentComputers.ownerId))
        .orderBy(sql`${agentComputers.lastActiveAt} desc nulls last`);
      const items = await Promise.all(
        rows.map(async ({ computer, agentName, ownerName }) => ({
          queue_position: computer.state === 'queued' ? await queuePosition(computer.id) : null,
          backups: await backups.list(computer.id),
          id: computer.id,
          agent_id: computer.agentId,
          agent_name: agentName,
          owner_id: computer.ownerId,
          owner_name: ownerName,
          state: computer.state,
          state_reason: computer.stateReason,
          last_active_at: computer.lastActiveAt,
          last_started_at: computer.lastStartedAt,
        })),
      );
      return {
        items,
        capacity: await capacity(),
        running: items.filter((item) => item.state === 'running' || item.state === 'starting').length,
      };
    },

    async setCapacity(actorId: string, input: ComputerCapacity): Promise<ComputerCapacity> {
      await admin(actorId);
      const stored = await deps.providers.defaultsOf('sandbox');
      await deps.providers.setDefaults(actorId, 'sandbox', { ...stored, ...input });
      await audit({
        actorId,
        action: 'computer.capacity',
        resourceType: 'provider_binding',
        resourceId: 'sandbox',
        summary: 'idle_minutes, max_running',
      });
      await service.drainQueue();
      return capacity();
    },

    /** An admin stops a member's computer; its home stays. */
    async adminStop(actorId: string, id: string): Promise<void> {
      await admin(actorId);
      const row = await byId(id);
      await stopRow(row, 'admin');
      await audit({ actorId, action: 'computer.stop', resourceType: 'computer', resourceId: id, summary: 'stopped' });
    },

    /**
     * An admin resets a member's computer: it is removed with its home, and the next use starts a
     * new one. Background processes on it are gone too.
     */
    async adminReset(actorId: string, id: string): Promise<void> {
      await admin(actorId);
      await transaction(async () => {
        await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
        const current = await byId(id);
        if (current.state === 'starting')
          throw conflict('computer_starting', 'Wait for the computer to finish starting.');
        await backups.prune(id, true);
        const row = await byId(id);
        await (await clientFor(row, row.ownerId)).remove(row.sandboxRef, { keepHome: false });
        await getDb().delete(agentComputers).where(eq(agentComputers.id, id));
        deps.hub.publish([row.ownerId], {
          type: 'computer.updated',
          data: { agent_id: row.agentId, state: 'stopped' },
        });
        await audit({
          actorId,
          action: 'computer.reset',
          resourceType: 'computer',
          resourceId: id,
          summary: 'home removed',
        });
      });
      await service.drainQueue();
    },

    /**
     * Computers left idle stop; one with a running process never does, nor one whose Agent
     * waits for its member to take over or to approve a sign-in (the page would be gone).
     */
    async stopIdle(): Promise<void> {
      const { idle_minutes: minutes } = await capacity();
      const idle = await getDb()
        .select()
        .from(agentComputers)
        .where(
          and(
            eq(agentComputers.state, 'running'),
            lt(agentComputers.lastActiveAt, new Date(Date.now() - minutes * 60_000).toISOString()),
          ),
        );
      for (const computer of idle) {
        try {
          const [waiting] = await getDb()
            .select({ id: requests.id })
            .from(requests)
            .where(
              and(
                // A take-over or a sign-in card: the page the member is asked about must still be there.
                inArray(requests.kind, ['takeover', 'login']),
                eq(requests.status, 'pending'),
                eq(requests.agentId, computer.agentId),
                eq(requests.memberId, computer.ownerId),
              ),
            )
            .limit(1);
          if (waiting) continue;
          const client = await clientFor(computer, computer.ownerId);
          const listed = await client.exec(computer.sandboxRef, {
            argv: ['gh-jobs', 'running'],
            user: 'agent',
            timeoutMs: 30_000,
          });
          // Not knowing is not the same as none running: keep it up.
          if (listed.exitCode !== 0 || Number(listed.stdout.trim()) > 0) continue;
          await stopRow(computer, 'idle');
        } catch (error) {
          logger.warn('[computers] could not stop an idle computer', {
            computer: computer.id,
            error: toErrorMessage(error),
          });
        }
      }
    },

    async drainQueue(): Promise<void> {
      const abandoned = await getDb()
        .select()
        .from(agentComputers)
        .where(
          and(
            eq(agentComputers.state, 'starting'),
            lt(agentComputers.updatedAt, new Date(Date.now() - 15 * 60_000).toISOString()),
          ),
        );
      for (const row of abandoned) {
        const client = await clientFor(row, row.ownerId);
        const state = await client.status(row.sandboxRef);
        await getDb()
          .update(agentComputers)
          .set({
            state: state === 'running' ? 'running' : 'stopped',
            stateReason: 'start_recovered',
            updatedAt: sql`now()`,
          })
          .where(and(eq(agentComputers.id, row.id), eq(agentComputers.version, row.version)));
      }
      const queued = await getDb()
        .select()
        .from(agentComputers)
        .where(eq(agentComputers.state, 'queued'))
        .orderBy(agentComputers.queuedAt, agentComputers.id);
      for (const row of queued) {
        try {
          await ensure(row.ownerId, row.agentId);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'computer_queued') break;
          if (!(error instanceof ApiError && error.code === 'computer_starting')) {
            const [failed] = await getDb()
              .update(agentComputers)
              .set({
                state: 'failed',
                queuedAt: null,
                stateReason: 'The queued start could not complete.',
                version: sql`${agentComputers.version} + 1`,
                updatedAt: sql`now()`,
              })
              .where(and(eq(agentComputers.id, row.id), eq(agentComputers.state, 'queued')))
              .returning();
            if (failed)
              deps.hub.publish([row.ownerId], {
                type: 'computer.updated',
                data: { agent_id: row.agentId, state: 'failed' },
              });
          }
        }
      }
    },

    async adminBackup(actorId: string, id: string) {
      await admin(actorId);
      const result = await transaction(async () => {
        await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
        const row = await byId(id);
        if (row.state !== 'running') throw conflict('computer_not_running', 'Start the computer before backing it up.');
        try {
          await backups.take(row, await clientFor(row, row.ownerId));
        } catch (error) {
          return { error };
        }
        await audit({ actorId, action: 'computer.backup', resourceType: 'computer', resourceId: id, summary: 'home' });
        return { backups: await backups.list(id) };
      });
      if ('error' in result) throw result.error;
      return result.backups;
    },

    async adminRestore(actorId: string, id: string, backupId: string) {
      await admin(actorId);
      await transaction(async () => {
        await getDb().execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
        const row = await byId(id);
        if (row.state !== 'stopped')
          throw conflict('computer_not_stopped', 'Stop the computer before restoring its home.');
        const started = await ensure(row.ownerId, row.agentId);
        try {
          await backups.restore(row, started.client, backupId);
        } finally {
          await started.client.restart(row.sandboxRef);
          await started.client.stop(row.sandboxRef);
          await setState(row.id, 'stopped', 'restore');
        }
        await audit({ actorId, action: 'computer.restore', resourceType: 'computer', resourceId: id, summary: 'home' });
      });
      await service.drainQueue();
    },

    /** Checks watched processes and idle computers every minute. */
    startWatching(deliver: Deliver) {
      ticker ??= setInterval(() => {
        void service
          .checkWatches(deliver)
          .then(() => service.stopIdle())
          .then(() => service.drainQueue())
          .catch((error) => logger.warn('[computers] lifecycle check failed', { error: toErrorMessage(error) }));
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
