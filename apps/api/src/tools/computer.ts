/**
 * Cloud computer tools (v1.6, MCP group `computer`): a member's own hosted
 * sandbox for their agent — run commands, look at and read files in it, move
 * files between it and Files, stop it.
 *
 * All four sit on the external surfaces only (agent-runtime/service-tools.ts);
 * the in-app assistant does not get a computer. Lifecycle, billing and the
 * workspace switch live in computer/service.ts: nothing here starts a computer
 * while the switch is off, and reads never start one.
 *
 * Tiers: computer_exec, computer_transfer and computer_stop are writes —
 * recorded in the member's name over MCP; computer_files (list / read) is a
 * read.
 */

import { posix } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { findBudgetRefusal } from '../usage/budget-errors.js';
import { currentMeteringScope, type MeteringScope } from '../usage/metering.js';
import { MAX_AGENT_UPLOAD_BYTES } from '../drive/cabinet-limits.js';
import { readCabinetFileBytes, uploadCabinetFile } from '../drive/kb-cabinet.js';
import { delegatedAgentActor } from '../platform/actor.js';
import { COMPUTER_EXEC_MAX_SECONDS, COMPUTER_HOME, COMPUTER_IDLE_MINUTES } from '../computer/config.js';
import {
  COMPUTER_DISABLED_MESSAGE,
  ComputerUnavailableError,
  NOT_RUNNING_MESSAGE,
  currentComputer,
  ensureComputer,
  isComputerEnabled,
  stopMemberComputer,
  withHeartbeat,
  type UsableComputer,
} from '../computer/service.js';
import { getComputerDriver, type ComputerDriver } from '../computer/driver.js';

/** Each output stream of one command keeps at most this much. */
const MAX_OUTPUT_BYTES = 200_000;
/** computer_files read: the largest file returned inline. */
const MAX_READ_BYTES = 1024 * 1024;
/** computer_transfer into the computer: the largest file copied from Files. */
const MAX_COPY_IN_BYTES = 25 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;

const BILLING_NOTE = `Billed per minute while it runs, against your member budget; it stops after ${COMPUTER_IDLE_MINUTES} idle minutes and its files go with it — save results to Files with computer_transfer first.`;

export const COMPUTER_TOOL_IDS: ReadonlySet<string> = new Set([
  'computer_exec',
  'computer_files',
  'computer_transfer',
  'computer_stop',
]);

/** Why a computer tool cannot run at all right now (the switch is off), or null. */
export async function computerToolUnavailableMessage(toolId: string): Promise<string | null> {
  if (!COMPUTER_TOOL_IDS.has(toolId)) return null;
  return (await isComputerEnabled()) ? null : COMPUTER_DISABLED_MESSAGE;
}

// ─── Paths ───────────────────────────────────────────────

/** An absolute path in the computer: relative paths start at the home folder. */
export function computerPath(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('That path is not valid.');
  return posix.resolve(COMPUTER_HOME, value || '.');
}

/** One argument for bash, single-quoted. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function listCommand(path: string): string {
  return [
    `cd -- ${shellQuote(path)} || exit 3`,
    `find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0' | head -z -n ${MAX_LIST_ENTRIES + 1}`,
  ].join('\n');
}

const TYPES: Record<string, string> = { d: 'folder', f: 'file', l: 'link' };

function parseListing(stdout: string) {
  const entries = stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [type, size, modified, ...name] = line.split('\t');
      return {
        name: name.join('\t'),
        type: TYPES[type ?? ''] ?? 'other',
        size: Number(size) || 0,
        modified_at: new Date(Number(modified) * 1000).toISOString(),
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES };
}

function decode(bytes: Buffer): { encoding: 'utf8' | 'base64'; content: string } {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) && !text.includes('\0')
    ? { encoding: 'utf8', content: text }
    : { encoding: 'base64', content: bytes.toString('base64') };
}

// ─── Context ─────────────────────────────────────────────

export interface ComputerToolContext {
  db: DatabaseProvider;
  userId: string;
  /** Test seam; production uses the workspace's E2B driver. */
  driver?: ComputerDriver;
}

function scopeOf(ctx: ComputerToolContext): MeteringScope {
  // MCP and the Agent API set the scope around every call; anything else is the member themselves.
  return currentMeteringScope() ?? { userId: ctx.userId, client: 'agent_api' };
}

function computerNote(computer: UsableComputer) {
  return {
    computer_id: computer.row.id,
    ...(computer.started ? { note: `A new cloud computer was started. ${BILLING_NOTE}` } : {}),
    ...(computer.replaced ? { replaced: 'Your previous computer had already stopped; its files are gone.' } : {}),
  };
}

/** Expected refusals come back as `{ error }`; an over-budget refusal reaches the agent in its own words. */
async function guarded<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    if (findBudgetRefusal(error)) throw error;
    if (error instanceof ComputerUnavailableError) return { error: error.message };
    return { error: toErrorMessage(error) };
  }
}

// ─── computer_exec ───────────────────────────────────────

const execSchema = z.object({
  command: z.string().min(1).max(20_000).describe('A bash command line, run as the computer user (sudo works).'),
  cwd: z
    .string()
    .max(4096)
    .optional()
    .describe(`Working folder; relative to ${COMPUTER_HOME}. Default the home folder.`),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(COMPUTER_EXEC_MAX_SECONDS)
    .default(120)
    .describe(`Stop the command after this many seconds (at most ${COMPUTER_EXEC_MAX_SECONDS}).`),
});

const execMeta: ToolMeta = {
  id: 'computer_exec',
  name: 'Cloud Computer: Run',
  brief: 'Run a command in your cloud computer',
  description:
    `Run a shell command in your own cloud computer (a Linux sandbox with internet access, created on first use). ` +
    `Returns exit code, stdout and stderr (each cut at ${MAX_OUTPUT_BYTES / 1000} KB; a long reply comes in pages via tool_output_read). ` +
    `${BILLING_NOTE} Bring inputs in from Files with computer_transfer.`,
  category: 'team',
  is_global: true,
  icon: 'Terminal',
  surface: { proxy: 'write', mcp: 'computer', openWorld: true, externalOnly: true },
  sort_order: 15,
};

export function createComputerExecTool(ctx: ComputerToolContext) {
  return tool({
    description: execMeta.description,
    inputSchema: execSchema,
    execute: (input: z.infer<typeof execSchema>) =>
      guarded(async () => {
        const cwd = computerPath(input.cwd);
        const computer = await ensureComputer(
          { db: ctx.db, userId: ctx.userId, scope: scopeOf(ctx) },
          { operationSeconds: input.timeout_seconds, ...(ctx.driver ? { driver: ctx.driver } : {}) },
        );
        const driver = ctx.driver ?? getComputerDriver();
        const result = await withHeartbeat(ctx.db, computer, driver, () =>
          driver.exec(computer.sandboxId, {
            command: input.command,
            cwd,
            timeoutMs: input.timeout_seconds * 1000,
            maxOutputBytes: MAX_OUTPUT_BYTES,
          }),
        );
        return {
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.stdoutBytes > MAX_OUTPUT_BYTES || result.stderrBytes > MAX_OUTPUT_BYTES
            ? { output_cut: { stdout_bytes: result.stdoutBytes, stderr_bytes: result.stderrBytes } }
            : {}),
          cwd,
          ...computerNote(computer),
        };
      }),
  });
}

// ─── computer_files ──────────────────────────────────────

const filesSchema = z.object({
  action: z.enum(['list', 'read']).describe('list: one folder. read: a file (at most 1 MB).'),
  path: z.string().max(4096).optional().describe(`Relative to ${COMPUTER_HOME}, or absolute. Default the home folder.`),
});

const filesMeta: ToolMeta = {
  id: 'computer_files',
  name: 'Cloud Computer: Files',
  brief: 'List and read files in your cloud computer',
  description:
    'List a folder or read a file (up to 1 MB; text as UTF-8, anything else as base64) in your running cloud ' +
    'computer. Never starts a computer. To keep a file, save it to Files with computer_transfer.',
  category: 'team',
  is_global: true,
  icon: 'FolderOpen',
  surface: { proxy: 'read', mcp: 'computer', openWorld: true, externalOnly: true },
  sort_order: 16,
};

export function createComputerFilesTool(ctx: ComputerToolContext) {
  return tool({
    description: filesMeta.description,
    inputSchema: filesSchema,
    execute: (input: z.infer<typeof filesSchema>) =>
      guarded(async () => {
        const path = computerPath(input.path);
        const computer = await currentComputer(ctx, ctx.driver ? { driver: ctx.driver } : {});
        if (!computer) return { error: NOT_RUNNING_MESSAGE };
        const driver = ctx.driver ?? getComputerDriver();
        if (input.action === 'list') {
          const result = await driver.exec(computer.sandboxId, {
            command: listCommand(path),
            timeoutMs: 30_000,
            maxOutputBytes: 512 * 1024,
          });
          if (result.exitCode === 3) return { error: `There is no folder ${path} in the computer.` };
          if (result.exitCode !== 0) return { error: result.stderr.trim().slice(-300) || 'Listing failed.' };
          return { path, ...parseListing(result.stdout) };
        }
        const bytes = await driver.readFile(computer.sandboxId, { path, maxBytes: MAX_READ_BYTES });
        return { path, size: bytes.length, ...decode(bytes) };
      }),
  });
}

// ─── computer_transfer ───────────────────────────────────

const transferSchema = z.object({
  action: z
    .enum(['files.copy_to_computer', 'computer.save_to_files'])
    .describe(
      'files.copy_to_computer: copy a file from Files into the computer (starts one if needed). ' +
        'computer.save_to_files: save a file from the computer as a new file in Files.',
    ),
  file_id: z.coerce.string().optional().describe('files.copy_to_computer: the file in Files.'),
  path: z
    .string()
    .max(4096)
    .optional()
    .describe(
      `copy_to_computer: where to put it (default ${COMPUTER_HOME}/<file name>). save_to_files: the file to save. Relative to ${COMPUTER_HOME}.`,
    ),
  shelf: z
    .enum(['personal', 'team'])
    .optional()
    .describe('save_to_files: your personal shelf (default) or the team shelf.'),
  folder_id: z.coerce.string().optional().describe('save_to_files: the folder in Files (default the shelf root).'),
  name: z.string().max(255).optional().describe('save_to_files: the name in Files (default the file name).'),
});

const transferMeta: ToolMeta = {
  id: 'computer_transfer',
  name: 'Cloud Computer: Transfer',
  brief: 'Move files between Files and your cloud computer',
  description:
    `Copy a file from Files into your cloud computer (up to ${MAX_COPY_IN_BYTES / 1024 / 1024} MB; starts the computer if needed), ` +
    `or save a file from the computer into Files (up to ${MAX_AGENT_UPLOAD_BYTES / 1024 / 1024} MB, personal shelf by default). ` +
    'Files you can see on Files are the only ones you can copy in.',
  category: 'team',
  is_global: true,
  icon: 'ArrowLeftRight',
  surface: { proxy: 'write', mcp: 'computer', openWorld: true, externalOnly: true },
  sort_order: 17,
};

export function createComputerTransferTool(ctx: ComputerToolContext) {
  return tool({
    description: transferMeta.description,
    inputSchema: transferSchema,
    execute: (input: z.infer<typeof transferSchema>) =>
      guarded(async () => {
        const cabinet = { db: ctx.db, userId: ctx.userId, actor: delegatedAgentActor({ userId: ctx.userId }) };
        const driver = ctx.driver ?? getComputerDriver();
        if (input.action === 'files.copy_to_computer') {
          if (!input.file_id) return { error: 'file_id is required for files.copy_to_computer.' };
          const source = await readCabinetFileBytes(cabinet, { fileId: input.file_id, maxBytes: MAX_COPY_IN_BYTES });
          if ('error' in source) return source;
          const path = computerPath(input.path ?? source.file.name);
          const computer = await ensureComputer(
            { db: ctx.db, userId: ctx.userId, scope: scopeOf(ctx) },
            { operationSeconds: 120, driver },
          );
          await driver.writeFile(computer.sandboxId, { path, bytes: source.bytes });
          return { path, size: source.bytes.length, from_file_id: source.file.id, ...computerNote(computer) };
        }
        if (!input.path) return { error: 'path is required for computer.save_to_files.' };
        const path = computerPath(input.path);
        const computer = await currentComputer(ctx, { operationSeconds: 120, driver });
        if (!computer) return { error: NOT_RUNNING_MESSAGE };
        const bytes = await driver.readFile(computer.sandboxId, { path, maxBytes: MAX_AGENT_UPLOAD_BYTES });
        const saved = await uploadCabinetFile(cabinet, {
          shelf: input.shelf ?? 'personal',
          folderId: input.folder_id,
          name: input.name ?? posix.basename(path),
          bytes,
        });
        if ('error' in saved) return saved;
        return { saved_from: path, file: saved.file };
      }),
  });
}

// ─── computer_stop ───────────────────────────────────────

const stopSchema = z.object({});

const stopMeta: ToolMeta = {
  id: 'computer_stop',
  name: 'Cloud Computer: Stop',
  brief: 'Stop your cloud computer',
  description:
    'Stop your cloud computer now, so billing stops. Everything in it is deleted — save what you need into Files ' +
    'with computer_transfer (computer.save_to_files) first. The next computer_exec starts a fresh one.',
  category: 'team',
  is_global: true,
  icon: 'Power',
  surface: { proxy: 'write', mcp: 'computer', openWorld: true, externalOnly: true },
  sort_order: 18,
};

export function createComputerStopTool(ctx: ComputerToolContext) {
  return tool({
    description: stopMeta.description,
    inputSchema: stopSchema,
    execute: () =>
      guarded(async () => {
        if (!(await isComputerEnabled())) return { error: COMPUTER_DISABLED_MESSAGE };
        const stopped = await stopMemberComputer(ctx.db, ctx.userId, 'user', ctx.driver ? { driver: ctx.driver } : {});
        if (!stopped) return { status: 'not_running', message: 'No cloud computer was running.' };
        return {
          status: stopped.status,
          computer_id: stopped.id,
          minutes_billed: stopped.minutes_billed,
          ...(stopped.status === 'lost'
            ? { note: 'The provider did not confirm the stop; it ends on its own within minutes.' }
            : {}),
        };
      }),
  });
}

export const computerExecTool = defineTool({ meta: execMeta, kind: 'lazy' });
export const computerFilesTool = defineTool({ meta: filesMeta, kind: 'lazy' });
export const computerTransferTool = defineTool({ meta: transferMeta, kind: 'lazy' });
export const computerStopTool = defineTool({ meta: stopMeta, kind: 'lazy' });
