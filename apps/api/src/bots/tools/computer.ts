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
 * Take-over: the lease is checked when the call arrives and again once the
 * computer is up (starting it or waiting in the capacity queue can take a
 * minute), and the command is registered so a take-over in this process
 * kills it. Meeting the member at the computer leaves an implicit take-over
 * card for a foreground Bot (browser-session.ts `memberInControl`), whose
 * hand-back wakes it.
 *
 * Background turns get `status` and `read_file` only (never import_attachment:
 * a task's files are the ones its brief names, not the member's uploads).
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
import { computerStatusFor } from '../computer/runtime.js';
import { capSnapshot } from '../computer/snapshot.js';
import { BOT_TOOL_METAS } from './meta.js';

const meta = BOT_TOOL_METAS.find((m) => m.id === 'computer')!;

export const AGENT_HOME = '/home/agent';
export const AGENT_WORKDIR = '/home/agent/work';
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

const COMPUTER_ACTIONS = ['shell', 'read_file', 'write_file', 'share_file', 'import_attachment', 'status'] as const;
const BACKGROUND_COMPUTER_ACTIONS = ['status', 'read_file'] as const;

/**
 * How to run long work. A background job must detach all three stdio
 * streams: `nohup cmd &` keeps the exec's stdout pipe open, so the call runs
 * into its timeout and the job is killed with it.
 */
const LONG_JOB_HINT =
  'For long work start a detached job that writes to a log: `setsid -f cmd > ~/work/job.log 2>&1 < /dev/null` (or `nohup cmd > ~/work/job.log 2>&1 < /dev/null &`), then check it later with `tail ~/work/job.log`. Without the redirects the call waits for the job and it is killed at the timeout.';

const fields = {
  command: z
    .string()
    .max(20_000)
    .optional()
    .describe(
      'shell: bash script, runs in ~/work. Long jobs: `setsid -f cmd > ~/work/job.log 2>&1 < /dev/null`, then tail the log.',
    ),
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
  timeout_s?: number;
  path?: string;
  content?: string;
  file_id?: string;
};

/** Resolve a path the model gave: `~` is the agent's home, relative paths are in ~/work. */
export function resolveAgentPath(raw: string): string {
  const value = raw.trim();
  if (value === '~') return AGENT_HOME;
  if (value.startsWith('~/')) return posix.resolve(AGENT_HOME, value.slice(2));
  return posix.resolve(AGENT_WORKDIR, value);
}

export function isUnderAgentHome(path: string): boolean {
  return path === AGENT_HOME || path.startsWith(`${AGENT_HOME}/`);
}

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

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
};

function contentTypeFor(name: string): string {
  return CONTENT_TYPES[posix.extname(name).toLowerCase()] ?? 'application/octet-stream';
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
      // Start it (or wait in the queue) first, then check again: the member
      // may have taken over during that wait.
      await deps.ensureReady(turn.userId, { signal: action.signal });
      if (await memberHasIt()) return await memberInControl(turn, { reason: 'interrupted' });
      throwIfAborted(action.signal);
      void deps.touch(turn.userId).catch(() => undefined);
      switch (input.action) {
        case 'shell':
          return await this.shell(input.command, input.timeout_s, action.signal);
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
const backgroundSchema = z.object({ action: z.enum(BACKGROUND_COMPUTER_ACTIONS), path: fields.path });

export function createComputerTool(turn: ComputerTurn, deps: ComputerDeps = defaultComputerDeps): Tool {
  if (turn.background) {
    return tool({
      description: `${meta.description}\nIn this background task only status and read_file work (read-only).`,
      inputSchema: backgroundSchema,
      execute: (input) => new ComputerActions(turn, deps).run(input),
    });
  }
  return tool({
    description: meta.description,
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
