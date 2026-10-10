/**
 * `computer` — shell and files on the member's computer, as uid `agent`.
 *
 * The shell runs in the container as `agent`, which by construction cannot
 * reach the browser, the screen or the browser profile (two uids + 0600
 * sockets, see apps/bot-computer). Output is untrusted (it can echo anything
 * from the internet) so every result marks the turn tainted, is capped, and
 * goes through the computer's secret redaction.
 *
 * `share_file` turns a file into a chat attachment of this conversation —
 * the same `chat_files` store and authenticated download route as exports and
 * uploads, so access follows the conversation (owner-only for Bots).
 * `import_attachment` is the way back: a file attached in THIS conversation
 * is copied (bytes, never shown) into ~/work for the shell to work on.
 *
 * Long work (installs, builds, downloads, data runs) outlives a 120 s shell
 * call as a background process (`run_background`, computer/jobs.ts over the
 * image's `gh-jobs`): detached in its own session with its output in a log,
 * spared by a take-over, keeping the computer awake while it runs. Its log is
 * command output like any other — redacted, capped, and it taints the turn.
 *
 * Take-over: the lease is checked when the call arrives and again once the
 * computer is up (starting it or waiting in the capacity queue can take a
 * minute), and the command is registered so a take-over in this process
 * kills it. Meeting the member at the computer leaves an implicit take-over
 * card for a foreground Bot (browser-session.ts `memberInControl`), whose
 * hand-back wakes it.
 *
 * Background turns get `status`, `read_file`, `processes` and `process_log`
 * only (never import_attachment: a task's files are the ones its brief names,
 * not the member's uploads; never starting or stopping a process).
 */

import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { putObjectAtKey, deleteObjectAtKey, getObjectAtKey } from '../../storage/uploads.js';
import { sanitizeUploadName } from '../../storage/filename.js';
import {
  abortable,
  afterLeaseChange,
  defaultComputerDeps,
  failure,
  memberInControl,
  throwIfAborted,
  toFailure,
  type ComputerDeps,
  type ComputerTurn,
  type ToolFailure,
} from '../computer/browser-session.js';
import { ComputerUnavailableError } from '../computer/access.js';
import { ComputerDockerError } from '../computer/docker.js';
import { JOB_ID, JOB_LOG_DEFAULT_LINES, JOB_LOG_MAX_LINES, JOB_NAME_MAX } from '../computer/jobs.js';
import { computerStatusFor } from '../computer/runtime.js';
import { capSnapshot, capTail } from '../computer/snapshot.js';
import { AGENT_HOME, AGENT_WORKDIR, contentTypeFor, isUnderAgentHome, resolveAgentPath } from './agent-paths.js';
import { BOT_TOOL_METAS } from './meta.js';

export { AGENT_HOME, AGENT_WORKDIR, isUnderAgentHome, resolveAgentPath } from './agent-paths.js';

const meta = BOT_TOOL_METAS.find((m) => m.id === 'computer')!;

/** Where import_attachment puts a file unless told otherwise. */
const IMPORT_DIR = `${AGENT_WORKDIR}/inbox`;
const SHELL_DEFAULT_TIMEOUT_S = 60;
const SHELL_MAX_TIMEOUT_S = 120;
const READ_MAX_BYTES = 256 * 1024;
const WRITE_MAX_BYTES = 1024 * 1024;
const SHARE_MAX_BYTES = 20 * 1024 * 1024;
const STDOUT_TOKENS = 2_500;
const STDERR_TOKENS = 800;
const FILE_TOKENS = 6_000;
/** `processes` lists the newest jobs only, each command cut short: the log is where the detail is. */
const PROCESS_LIST_MAX = 20;
const PROCESS_COMMAND_CHARS = 300;

const COMPUTER_ACTIONS = [
  'shell',
  'run_background',
  'processes',
  'process_log',
  'stop_process',
  'read_file',
  'write_file',
  'share_file',
  'import_attachment',
  'status',
] as const;
const BACKGROUND_COMPUTER_ACTIONS = ['status', 'read_file', 'processes', 'process_log'] as const;

/**
 * How to run long work: as a background process, never a shell call that
 * waits (it is killed at the timeout, and a hand-rolled `nohup cmd &` keeps
 * the call's output pipe open until then).
 */
const LONG_JOB_HINT =
  'For long work (installs, builds, downloads, data runs) use run_background {command}: it keeps running after this call, with its output in a log — check it with process_log {id}, stop it with stop_process {id}.';

const fields = {
  command: z
    .string()
    .max(20_000)
    .optional()
    .describe(
      'shell: bash script, runs in ~/work (≤120 s). run_background: the command to run as a background process in ~/work.',
    ),
  name: z
    .string()
    .max(JOB_NAME_MAX)
    .optional()
    .describe('run_background: a short label for the process list (default: the command’s first word).'),
  id: z.string().max(16).optional().describe('process_log/stop_process: the process id, like j1a2b3c4d.'),
  lines: z
    .number()
    .int()
    .min(1)
    .max(JOB_LOG_MAX_LINES)
    .optional()
    .describe(`process_log: how many lines from the end (default ${JOB_LOG_DEFAULT_LINES}).`),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(SHELL_MAX_TIMEOUT_S)
    .optional()
    .describe(`shell: seconds before it is killed (default ${SHELL_DEFAULT_TIMEOUT_S}).`),
  path: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'read_file/write_file/share_file: relative to ~/work, or absolute. import_attachment: where to put it inside ~/work (default ~/work/inbox/<name>).',
    ),
  content: z.string().optional().describe('write_file: the whole file content (≤1 MiB).'),
  file_id: z
    .string()
    .max(64)
    .optional()
    .describe('import_attachment: the file_id of a file attached in this conversation.'),
};

type ComputerInput = {
  action: (typeof COMPUTER_ACTIONS)[number];
  command?: string;
  name?: string;
  id?: string;
  lines?: number;
  timeout_s?: number;
  path?: string;
  content?: string;
  file_id?: string;
};

/** Text if the bytes are UTF-8 without NULs; null for binary. */
export function decodeText(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** Keep the head and tail of long command output. */
export function capOutput(text: string, maxTokens: number): string {
  return capSnapshot(
    text,
    maxTokens,
    (n) => `… [${n} lines omitted — narrow it down with head, tail, grep or sed -n] …`,
  ).text;
}

function invalidProcessId(action: string): ToolFailure {
  return failure('invalid', `${action} needs the id of a process (like j1a2b3c4d) from run_background or processes.`);
}

/** gh-jobs exits 3 for an id it does not know (jobs.ts maps it to not_found). */
function isUnknownJob(err: unknown): boolean {
  return err instanceof ComputerDockerError && err.code === 'not_found';
}

function unknownProcess(id: string): ToolFailure {
  return failure('not_found', `There is no process "${id}" on the computer. List them with processes.`);
}

class ComputerActions {
  constructor(
    readonly turn: ComputerTurn,
    readonly deps: ComputerDeps,
  ) {}

  private redact = (text: string) => this.deps.redact(this.turn.userId, text);

  async run(input: ComputerInput): Promise<Record<string, unknown> | ToolFailure> {
    const { turn, deps } = this;
    if (turn.background && !(BACKGROUND_COMPUTER_ACTIONS as readonly string[]).includes(input.action)) {
      return failure('not_allowed', `"${input.action}" is not available in a background task (read-only).`);
    }
    if (input.action === 'status') {
      try {
        return await this.status();
      } catch (err) {
        return toFailure(err, this.redact);
      }
    }
    // Aborts with the turn, and when the member takes over in this process.
    const action = deps.trackAction(turn.userId, turn.signal);
    try {
      const memberHasIt = async () => (await deps.currentLease(turn.userId)).controller === 'user';
      // Fast path: do not start the computer for a Bot that may not act.
      if (await memberHasIt()) return await memberInControl(turn, { reason: 'waiting' });
      // A stopped computer runs no processes: listing or stopping one never starts it.
      if (input.action === 'processes') return await this.processes();
      if (input.action === 'stop_process') return await this.stopProcess(input.id);
      // Start it (or wait in the queue) first, then check again: the member
      // may have taken over during that wait.
      await deps.ensureReady(turn.userId, { signal: action.signal });
      if (await memberHasIt()) return await memberInControl(turn, { reason: 'interrupted' });
      throwIfAborted(action.signal);
      void deps.touch(turn.userId).catch(() => undefined);
      switch (input.action) {
        case 'shell':
          return await this.shell(input.command, input.timeout_s, action.signal);
        case 'run_background':
          return await this.runBackground(input.command, input.name, action.signal);
        case 'process_log':
          return await this.processLog(input.id, input.lines, action.signal);
        case 'read_file':
          return await this.readFile(input.path, action.signal);
        case 'write_file':
          return await this.writeFile(input.path, input.content, action.signal);
        case 'share_file':
          return await this.shareFile(input.path, action.signal);
        case 'import_attachment':
          return await this.importAttachment(input.file_id, input.path, action.signal);
      }
    } catch (err) {
      const fail = toFailure(err, this.redact);
      // Taken over mid-command (killed in this process, or refused by a file
      // command): a card for the hand-back, or the member already gave it back.
      if (fail.code === 'user_in_control') return await afterLeaseChange(turn, deps, () => ({ reason: 'interrupted' }));
      if (fail.code === 'failed') {
        logger.warn('[bots/computer] action failed', { action: input.action, userId: turn.userId, error: fail.error });
      }
      return fail;
    } finally {
      action.done();
    }
  }

  private async status(): Promise<Record<string, unknown>> {
    const status = await computerStatusFor(this.turn.userId);
    return {
      runtime: status.runtime.state,
      state: status.state,
      controller: status.controller,
      queue_position: status.queue_position,
      last_active_at: status.last_active_at,
      note:
        status.runtime.state !== 'ready'
          ? 'The computer is not available on this deployment.'
          : status.state === 'running'
            ? undefined
            : 'The computer starts automatically when you use the browser or the shell.',
    };
  }

  private async shell(
    command: string | undefined,
    timeoutS: number | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | ToolFailure> {
    if (!command?.trim()) return failure('invalid', 'shell needs a command.');
    const timeoutSec = Math.min(Math.max(timeoutS ?? SHELL_DEFAULT_TIMEOUT_S, 1), SHELL_MAX_TIMEOUT_S);
    // Start in ~/work, recreating it if the member deleted it (the home is a
    // persistent volume, so the image's copy is not guaranteed to be there).
    const script = `cd ${AGENT_WORKDIR} 2>/dev/null || { mkdir -p ${AGENT_WORKDIR} && cd ${AGENT_WORKDIR}; } || cd ~\n${command}`;
    const result = await this.deps.exec(this.turn.userId, script, {
      timeoutSec,
      signal,
      user: 'agent',
      maxOutputBytes: 64 * 1024,
    });
    // A killed command returns like a finished one: a take-over (or a Stop)
    // must not hand its partial output to the Bot as if it had run.
    throwIfAborted(signal);
    // Command output is outside content with no origin (it can echo anything).
    this.turn.noteObservation(null);
    this.turn.markTainted();
    return {
      exit_code: result.exitCode,
      stdout: capOutput(this.redact(result.stdout), STDOUT_TOKENS),
      stderr: capOutput(this.redact(result.stderr), STDERR_TOKENS),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.timedOut ? { timed_out: true, note: `Killed after ${timeoutSec} s. ${LONG_JOB_HINT}` } : {}),
    };
  }

  /** Start a background process; its output goes to its log, never into this result. */
  private async runBackground(
    command: string | undefined,
    name: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | ToolFailure> {
    if (!command?.trim()) return failure('invalid', 'run_background needs a command.');
    let job;
    try {
      job = await this.deps.startJob(this.turn.userId, { command, ...(name?.trim() ? { name } : {}) }, { signal });
    } catch (err) {
      throwIfAborted(signal); // a take-over killed the start: say so, not "exit -1"
      throw err;
    }
    return {
      id: job.id,
      name: this.redact(job.name),
      status: 'running',
      started_at: job.started_at,
      note: `Running in the background in ~/work. It keeps going after your turn (also if the member takes over the computer); its output goes to its log. Check it with process_log {id: "${job.id}"} and tell the member it is running rather than waiting for it. Nothing tells you when it ends: never promise to report back on your own — offer to check when the member asks.`,
    };
  }

  /** The member's background processes, newest first (the Bots' and the member's own). */
  private async processes(): Promise<Record<string, unknown>> {
    const jobs = await this.deps.listJobs(this.turn.userId);
    // Names and commands were written on the computer: outside content.
    this.turn.noteObservation(null);
    this.turn.markTainted();
    const shown = jobs.slice(0, PROCESS_LIST_MAX).map((job) => {
      const command = this.redact(job.command);
      return {
        id: job.id,
        name: this.redact(job.name),
        command: command.length > PROCESS_COMMAND_CHARS ? `${command.slice(0, PROCESS_COMMAND_CHARS)}…` : command,
        status: job.status,
        exit_code: job.exit_code,
        started_at: job.started_at,
        ended_at: job.ended_at,
        log_bytes: job.log_bytes,
      };
    });
    const note =
      jobs.length === 0
        ? 'No background processes (run_background starts one).'
        : jobs.some((job) => job.status === 'lost')
          ? 'lost = it was running when the computer stopped, so it has no exit code; its log is still readable.'
          : undefined;
    return {
      processes: shown,
      ...(jobs.length > shown.length ? { more: jobs.length - shown.length } : {}),
      ...(note ? { note } : {}),
    };
  }

  /** The end of a process's log — command output: redacted, capped, and it taints the turn. */
  private async processLog(
    rawId: string | undefined,
    lines: number | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | ToolFailure> {
    const id = rawId?.trim() ?? '';
    if (!JOB_ID.test(id)) return invalidProcessId('process_log');
    let log;
    try {
      log = await this.deps.jobLog(this.turn.userId, id, { ...(lines ? { lines } : {}), signal });
    } catch (err) {
      throwIfAborted(signal);
      if (isUnknownJob(err)) return unknownProcess(id);
      throw err;
    }
    throwIfAborted(signal);
    this.turn.noteObservation(null);
    this.turn.markTainted();
    const capped = capTail(
      this.redact(log.text),
      STDOUT_TOKENS,
      (n) => `… [${n} earlier lines omitted — the whole log is ~/.local/state/gh-jobs/${id}/log] …`,
    );
    return {
      id,
      text: capped.text,
      ...(log.truncated || capped.truncated ? { truncated: true } : {}),
      ...(log.text.trim() ? {} : { note: 'The log is empty so far.' }),
    };
  }

  private async stopProcess(rawId: string | undefined): Promise<Record<string, unknown> | ToolFailure> {
    const id = rawId?.trim() ?? '';
    if (!JOB_ID.test(id)) return invalidProcessId('stop_process');
    try {
      const result = await this.deps.stopJob(this.turn.userId, id);
      return result.stopped
        ? { id, stopped: true }
        : { id, stopped: false, note: 'It was not running any more (see processes for how it ended).' };
    } catch (err) {
      if (isUnknownJob(err)) return unknownProcess(id);
      if (err instanceof ComputerUnavailableError && err.code === 'stopped') {
        return { id, stopped: false, note: 'The computer is not running, so neither is this process.' };
      }
      throw err;
    }
  }

  private async readFile(raw: string | undefined, signal: AbortSignal): Promise<Record<string, unknown> | ToolFailure> {
    if (!raw?.trim()) return failure('invalid', 'read_file needs a path.');
    const path = resolveAgentPath(raw);
    const buffer = await this.deps.readFile(this.turn.userId, path, { maxBytes: READ_MAX_BYTES + 1, signal });
    this.turn.noteObservation(null);
    this.turn.markTainted();
    if (buffer.length > READ_MAX_BYTES) {
      return failure(
        'too_large',
        `${path} is larger than 256 KiB. Read parts of it with shell (head, sed -n, rg), or share_file it.`,
      );
    }
    const text = decodeText(buffer);
    if (text === null) {
      return failure(
        'binary',
        `${path} is not a text file. Use share_file to give it to the member, or inspect it with shell.`,
      );
    }
    const content = capOutput(this.redact(text), FILE_TOKENS);
    return { path, bytes: buffer.length, content, ...(content !== text ? { truncated: true } : {}) };
  }

  private async writeFile(
    raw: string | undefined,
    content: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | ToolFailure> {
    if (!raw?.trim()) return failure('invalid', 'write_file needs a path.');
    if (content === undefined) return failure('invalid', 'write_file needs content.');
    const path = resolveAgentPath(raw);
    if (!isUnderAgentHome(path) || path === AGENT_HOME) {
      return failure('forbidden_path', `Files can only be written inside ${AGENT_HOME}.`);
    }
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > WRITE_MAX_BYTES)
      return failure('too_large', 'write_file is limited to 1 MiB; write in parts with shell.');
    await this.deps.writeFile(this.turn.userId, path, bytes, { signal });
    return { path, bytes: bytes.length, written: true };
  }

  private async shareFile(
    raw: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | ToolFailure> {
    if (!raw?.trim()) return failure('invalid', 'share_file needs a path.');
    const path = resolveAgentPath(raw);
    if (!isUnderAgentHome(path)) return failure('forbidden_path', `Only files inside ${AGENT_HOME} can be shared.`);
    const name = sanitizeUploadName(posix.basename(path));
    if (!name) return failure('invalid', 'That file name cannot be used; rename the file first.');
    const buffer = await this.deps.readFile(this.turn.userId, path, { maxBytes: SHARE_MAX_BYTES + 1, signal });
    if (buffer.length > SHARE_MAX_BYTES)
      return failure('too_large', `${name} is larger than 20 MB. Compress or split it first.`);

    const contentType = contentTypeFor(name);
    // Same key layout as member uploads (routes/chat-files.ts): the random
    // segment makes the object unguessable even through a presigned URL.
    const storageKey = `chat-files/${this.turn.userId}/${randomUUID()}/${name}`;
    await putObjectAtKey(storageKey, buffer, contentType);
    try {
      const file = await this.turn.db.chatFiles.create({
        session_id: this.turn.sessionId,
        name,
        content_type: contentType,
        size: buffer.length,
        storage_key: storageKey,
        source: 'agent',
        created_by: this.turn.userId,
      });
      return {
        type: 'file',
        file_id: file.id,
        name: file.name,
        content_type: file.content_type,
        size: file.size,
        download_url: `/api/chat-files/${file.id}/content`,
      };
    } catch (err) {
      await deleteObjectAtKey(storageKey).catch(() => undefined);
      logger.warn('[bots/computer] share_file failed', { userId: this.turn.userId, error: toErrorMessage(err) });
      return failure('failed', 'Sharing the file failed. Try again.');
    }
  }

  /**
   * Copy a file the member attached in this conversation into ~/work. The id
   * comes from the model, so the conversation bound is the authorization: a
   * file of another conversation is "not found". The bytes are copied as they
   * are (binary-safe) and never shown to the Bot, so the turn is not tainted
   * here — reading the file later is — but the vault's ledger records outside
   * content, so a later fill in this turn asks the member first.
   */
  private async importAttachment(
    rawId: string | undefined,
    rawPath: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | ToolFailure> {
    const fileId = rawId?.trim();
    if (!fileId)
      return failure('invalid', 'import_attachment needs the file_id of a file attached in this conversation.');
    const [file] = await this.turn.db.chatFiles.listBySessionAndIds(this.turn.sessionId, [fileId]);
    if (!file) return failure('not_found', `There is no attachment ${fileId} in this conversation.`);
    const name = sanitizeUploadName(file.name) ?? 'attachment';
    const wanted = rawPath?.trim();
    // A trailing slash names a folder: the file keeps its own name inside it.
    const path = !wanted
      ? posix.join(IMPORT_DIR, name)
      : /[/\\]$/.test(wanted)
        ? posix.join(resolveAgentPath(wanted), name)
        : resolveAgentPath(wanted);
    if (!path.startsWith(`${AGENT_WORKDIR}/`)) {
      return failure('forbidden_path', `Attachments can only be put inside ${AGENT_WORKDIR}.`);
    }
    const tooLarge = () =>
      failure('too_large', `${name} is larger than 20 MB, so it cannot be copied to the computer.`);
    if (file.size > SHARE_MAX_BYTES) return tooLarge();
    const object = await abortable(getObjectAtKey(file.storage_key), signal);
    if (!object) return failure('not_found', `${name} is no longer stored; ask the member to attach it again.`);
    if (object.buffer.length > SHARE_MAX_BYTES) return tooLarge();
    throwIfAborted(signal);
    await this.deps.writeFile(this.turn.userId, path, object.buffer, { signal });
    this.turn.noteObservation(null);
    return { path, size: object.buffer.length, name };
  }
}

const foregroundSchema = z.object({ action: z.enum(COMPUTER_ACTIONS), ...fields });
const backgroundSchema = z.object({
  action: z.enum(BACKGROUND_COMPUTER_ACTIONS),
  path: fields.path,
  id: fields.id,
  lines: fields.lines,
});

/**
 * What sleep does to running work differs by host, and a Bot that gets it wrong
 * either promises what it cannot keep or restarts work that is still running.
 */
const SLEEP_FACTS: Record<'docker' | 'e2b', string> = {
  docker: 'When the computer goes to sleep, running processes end — background ones too; files stay.',
  e2b: 'When the computer goes to sleep, everything is frozen, running processes included, and carries on when it wakes; only a reset or an upgrade ends them (files stay).',
};

export function createComputerTool(
  turn: ComputerTurn,
  deps: ComputerDeps = defaultComputerDeps,
  host: 'docker' | 'e2b' = 'docker',
): Tool {
  const description = `${meta.description}\n${SLEEP_FACTS[host]}`;
  if (turn.background) {
    return tool({
      description: `${description}\nIn this background task only status, read_file, processes and process_log work (read-only).`,
      inputSchema: backgroundSchema,
      execute: (input) => new ComputerActions(turn, deps).run(input),
    });
  }
  return tool({
    description,
    inputSchema: foregroundSchema,
    execute: (input) => new ComputerActions(turn, deps).run(input),
  });
}

/** For tests: run one action without going through the AI SDK. */
export function runComputerAction(
  turn: ComputerTurn,
  input: ComputerInput,
  deps: ComputerDeps = defaultComputerDeps,
): Promise<Record<string, unknown> | ToolFailure> {
  return new ComputerActions(turn, deps).run(input);
}
