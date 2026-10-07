/**
 * Files on a member's computer, for the member — the Files tab (spec
 * 20261007 §2.4): list a folder, download a file, upload one.
 *
 * Everything runs as uid `agent` inside the container — the Bots' shell and
 * the member's terminal, one sandbox — so the browser profile in
 * /home/browser stays out of reach whatever a path says. Paths are resolved
 * the way the computer tool resolves the model's (`~` = /home/agent, relative
 * = ~/work) and must stay under /home/agent: checked here on the string, and
 * again in the container on the real path (`realpath -e`), so a symlink
 * inside the home cannot lead out of it. Paths and names reach the container
 * as arguments, never as script text.
 *
 * Limits: a listing returns at most 500 entries (folders first, then by
 * name); a download streams one regular file of at most 1 GiB, exactly the
 * size announced up front (a file that shrinks mid-way fails the download
 * instead of cutting it short silently); an upload streams at most 100 MiB
 * into the container and only appears under its name once every byte has
 * arrived, under a name that never overwrites anything (`name (1).ext` …).
 * Every call starts the computer when needed — even over the soft disk limit,
 * that is how a member gets in to clean up — and counts as activity.
 */

import { posix } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ComputerFileEntry, ComputerFileList } from '@greenhouse/types/bots';

import { sanitizeUploadName } from '../../storage/filename.js';
import { AGENT_HOME, isUnderAgentHome, resolveAgentPath } from '../tools/agent-paths.js';
import { containerFailed, touchComputer } from './access.js';
import { ComputerDockerError, type DockerClient } from './docker.js';
import { requireComputerRuntime } from './runtime.js';

export const LIST_MAX_ENTRIES = 500;
export const DOWNLOAD_MAX_BYTES = 1024 ** 3;
export const UPLOAD_MAX_BYTES = 100 * 1024 ** 2;
/** Where the Files tab opens, and where an upload without a folder goes. */
export const DEFAULT_FILES_DIR = '~/work';
/** Longest name an upload keeps, in UTF-8 bytes (ext4 allows 255; " (999)" needs room). */
const MAX_NAME_BYTES = 200;
/** In-flight uploads (UPLOAD_SCRIPT) — never shown in a listing. */
const UPLOAD_TEMP_PREFIX = '.gh-upload.';
const AGENT_ENV = { HOME: AGENT_HOME, USER: 'agent', LOGNAME: 'agent' };
/** A transfer still running after this long is cut. */
const TRANSFER_TIMEOUT_MS = 30 * 60_000;
/** A long transfer is activity: touched this often, so the idle stop never cuts one off. */
const TOUCH_EVERY_MS = 60_000;

export type ComputerFileErrorCode = 'invalid' | 'not_found' | 'too_large';

/**
 * What the member asked for cannot be done (400 `invalid`, 404 `not_found`,
 * 413 `too_large`) — as opposed to the computer failing, which goes through
 * the container-failure path (a vanished container marks the row, `stopped`).
 */
export class ComputerFileError extends Error {
  constructor(
    readonly code: ComputerFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ComputerFileError';
  }
}

// ─── Paths and names (pure) ───────────────────────────────

/**
 * The absolute path a member's path means (`~` = the agent home, relative =
 * ~/work; empty = `fallback`). Refuses anything outside /home/agent, and
 * control characters (a newline would forge lines in the script's errors).
 */
export function resolveMemberPath(raw: string | undefined, fallback = DEFAULT_FILES_DIR): string {
  const value = raw?.trim() || fallback;
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ComputerFileError('invalid', 'Invalid path');
  }
  const path = resolveAgentPath(value);
  if (!isUnderAgentHome(path)) throw new ComputerFileError('invalid', `Only files inside ${AGENT_HOME} are reachable`);
  return path;
}

/** `report.final.pdf` → `report.final` + `.pdf`; a leading dot belongs to the name (`.env`). */
export function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * The name an upload is stored under, before de-duplication: the shared
 * upload hygiene (sanitizeUploadName — CJK kept), shortened to fit the file
 * system with its extension kept. Null when nothing usable is left.
 */
export function uploadFileName(raw: string): { base: string; ext: string } | null {
  const clean = sanitizeUploadName(raw);
  if (!clean) return null;
  let { base, ext } = splitFileName(clean);
  if (Buffer.byteLength(ext) > 32) [base, ext] = [clean, ''];
  while (base && Buffer.byteLength(base + ext) > MAX_NAME_BYTES) base = [...base].slice(0, -1).join('');
  base = base.trim();
  return base ? { base, ext } : null;
}

const TYPES: Record<string, ComputerFileEntry['type']> = { f: 'file', d: 'dir', l: 'link' };

/**
 * The list script's output: the folder's real path, then one record per
 * entry — `type \t size \t mtime-seconds \t name` — each NUL-terminated
 * (names may hold tabs and newlines; only the first three tabs split).
 * Records it cannot read are skipped, never thrown.
 */
export function parseListing(stdout: Buffer, max = LIST_MAX_ENTRIES): ComputerFileList {
  const records = stdout.toString('utf8').split('\0');
  const path = records.shift() ?? '';
  const entries: ComputerFileEntry[] = [];
  let seen = 0;
  for (const record of records) {
    const parts = record.split('\t');
    if (parts.length < 4) continue;
    const [kind, size, mtime] = parts;
    const name = parts.slice(3).join('\t');
    if (!name || name.startsWith(UPLOAD_TEMP_PREFIX)) continue;
    seen++;
    if (entries.length >= max) continue;
    const type = TYPES[kind!] ?? 'other';
    const seconds = Number(mtime);
    entries.push({
      name,
      type,
      size: type === 'dir' ? 0 : Math.max(0, Math.floor(Number(size)) || 0),
      mtime: new Date(Number.isFinite(seconds) ? seconds * 1000 : 0).toISOString(),
    });
  }
  return { path, entries, truncated: seen > max };
}

// ─── Scripts (uid agent: `sh -c SCRIPT name args…`) ───────

/** `$r` = the real path of `$1`, which must exist and stay under the agent home. */
const REALPATH_PRELUDE = [
  'r=$(realpath -e -- "$1" 2>/dev/null) || { echo "No such file or folder" >&2; exit 3; }',
  'case "$r" in /home/agent|/home/agent/*) ;; *) echo "That leads outside /home/agent" >&2; exit 5 ;; esac',
];

/** Exit codes the scripts share; anything else is the computer failing. */
const EXIT = { notFound: 3, notFolder: 4, outside: 5, denied: 6, tooLarge: 7, cutShort: 8 } as const;

/** `$1` folder, `$2` max entries → its real path, then folders, then the rest, each by name (bytewise). */
export const LIST_SCRIPT = [
  ...REALPATH_PRELUDE,
  '[ -d "$r" ] || { echo "Not a folder" >&2; exit 4; }',
  '[ -r "$r" ] && [ -x "$r" ] || { echo "Permission denied" >&2; exit 6; }',
  'printf "%s\\0" "$r"',
  'tab=$(printf "\\t")',
  'fmt="%y\\t%s\\t%T@\\t%f\\0"',
  '{ find "$r" -mindepth 1 -maxdepth 1 -type d -printf "$fmt" 2>/dev/null | LC_ALL=C sort -z -t "$tab" -k4',
  '  find "$r" -mindepth 1 -maxdepth 1 ! -type d -printf "$fmt" 2>/dev/null | LC_ALL=C sort -z -t "$tab" -k4',
  '} | head -z -n "$(($2 + 1))"',
].join('\n');

/** `$1` file, `$2` max bytes → its size on one line, then exactly that many of its bytes. */
export const DOWNLOAD_SCRIPT = [
  ...REALPATH_PRELUDE,
  '[ -f "$r" ] || { echo "Not a regular file" >&2; exit 4; }',
  '[ -r "$r" ] || { echo "Permission denied" >&2; exit 6; }',
  's=$(stat -c %s -- "$r") || exit 3',
  '[ "$s" -le "$2" ] || { echo "The file is larger than 1 GiB" >&2; exit 7; }',
  'printf "%s\\n" "$s"',
  'exec head -c "$s" -- "$r"',
].join('\n');

/**
 * `$1` folder, `$2` base, `$3` extension, `$4` byte count; stdin = the file.
 * The bytes land in a hidden temporary file first; only a complete one moves
 * (rename) onto the first free name, claimed by an exclusive create
 * (noclobber) — so nothing is overwritten and two uploads never share a
 * name. Prints `size \t mtime \t name`.
 */
export const UPLOAD_SCRIPT = [
  ...REALPATH_PRELUDE,
  '[ -d "$r" ] || { echo "Not a folder" >&2; exit 4; }',
  `tmp=$(mktemp -p "$r" ${UPLOAD_TEMP_PREFIX}XXXXXXXX 2>/dev/null) || { echo "Cannot write to that folder" >&2; exit 6; }`,
  'trap \'rm -f -- "$tmp"\' EXIT',
  'head -c "$4" >"$tmp"',
  'got=$(stat -c %s -- "$tmp")',
  '[ "$got" = "$4" ] || { echo "The upload stopped after $got of $4 bytes" >&2; exit 8; }',
  'chmod 0644 -- "$tmp"',
  'name="$2$3"; i=0',
  'until ( set -C; : >"$r/$name" ) 2>/dev/null; do',
  '  [ -e "$r/$name" ] || [ -L "$r/$name" ] || { echo "Cannot write to that folder" >&2; exit 6; }',
  '  i=$((i + 1))',
  '  [ "$i" -lt 1000 ] || { echo "No free file name left" >&2; exit 6; }',
  '  name="$2 ($i)$3"',
  'done',
  'mv -f -- "$tmp" "$r/$name" || { rm -f -- "$r/$name"; echo "Cannot write to that folder" >&2; exit 6; }',
  'printf "%s\\t%s\\t%s\\n" "$got" "$(stat -c %Y -- "$r/$name")" "$name"',
].join('\n');

/** A script's exit, as the error the route answers with. */
function scriptFailure(code: number | null, stderr: string, what: string): Error {
  const message = stderr.trim().split('\n').pop()?.slice(0, 300) || `${what} failed`;
  switch (code) {
    case EXIT.notFound:
      return new ComputerFileError('not_found', message);
    case EXIT.notFolder:
    case EXIT.outside:
    case EXIT.denied:
      return new ComputerFileError('invalid', message);
    case EXIT.tooLarge:
      return new ComputerFileError('too_large', message);
    default:
      return new ComputerDockerError('failed', `${what} failed (exit ${code ?? 'killed'}): ${message}`);
  }
}

// ─── Dependencies (test seam) ─────────────────────────────

export interface FilesDeps {
  docker(): DockerClient;
  /** Start the member's computer when needed (over the soft disk limit too); its container. */
  container(userId: string): Promise<string>;
  touch(userId: string): Promise<void>;
  /** A docker failure: a vanished container marks the member's row and becomes `stopped`; else rethrown. */
  failed(userId: string, err: unknown): Promise<never>;
}

const defaultDeps: FilesDeps = {
  docker: () => requireComputerRuntime().docker,
  container: async (userId) =>
    (await requireComputerRuntime().controller.ensureRunning(userId, { allowOverQuota: true })).container_name,
  touch: touchComputer,
  failed: containerFailed,
};

async function rethrow(userId: string, err: unknown, deps: FilesDeps): Promise<never> {
  if (err instanceof ComputerFileError) throw err;
  return await deps.failed(userId, err);
}

// ─── List ─────────────────────────────────────────────────

/** A folder of the agent home (default ~/work): ≤500 entries, folders first, then by name. */
export async function listComputerFiles(
  userId: string,
  rawPath: string | undefined,
  deps: FilesDeps = defaultDeps,
): Promise<ComputerFileList> {
  const path = resolveMemberPath(rawPath);
  const container = await deps.container(userId);
  try {
    const result = await deps.docker().exec({
      container,
      user: 'agent',
      cwd: AGENT_HOME,
      env: AGENT_ENV,
      argv: ['sh', '-c', LIST_SCRIPT, 'gh-ls', path, String(LIST_MAX_ENTRIES)],
      timeoutMs: 30_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 4096,
    });
    if (result.code !== 0) throw scriptFailure(result.code, result.stderr, 'Listing the folder');
    return parseListing(result.stdout);
  } catch (err) {
    return await rethrow(userId, err, deps);
  } finally {
    void deps.touch(userId);
  }
}

// ─── Download ─────────────────────────────────────────────

export interface ComputerDownload {
  /** The file name the member asked for (the last segment of their path). */
  name: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

type Header = { header: string; rest: Buffer } | { code: number | null; stderr: string };

/** The script's first line (the size), or its exit when it fails first. Leaves stdout paused. */
function readHeader(child: ChildProcess): Promise<Header> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const finish = (value: Header) => {
      if (settled) return;
      settled = true;
      child.stdout!.off('data', onData);
      child.stdout!.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const newline = head.indexOf(0x0a);
      if (newline >= 0)
        finish({ header: head.subarray(0, newline).toString('utf8'), rest: head.subarray(newline + 1) });
      else if (head.length > 64) finish({ code: null, stderr: 'no size line' });
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    // 'close' waits for stdout to end, which a paused stream with data left never does early.
    child.once('close', (code) => finish({ code, stderr }));
    child.once('error', (err) => finish({ code: null, stderr: err.message }));
  });
}

/**
 * The rest of the script's stdout as a web stream of exactly `size` bytes,
 * with backpressure (the docker pipe pauses while the client reads slowly).
 * Cancelling it (the client went away) kills the transfer; a file that ends
 * early errors the stream rather than handing out a truncated copy.
 */
function bodyStream(child: ChildProcess, first: Buffer, size: number, onEnd: () => void): ReadableStream<Uint8Array> {
  const stdout = child.stdout!;
  let sent = 0;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    onEnd();
    stdout.removeAllListeners('data');
    child.kill('SIGKILL');
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (chunk: Buffer) => {
        if (done) return;
        const part = chunk.subarray(0, size - sent);
        sent += part.length;
        if (part.length > 0) controller.enqueue(new Uint8Array(part));
        if (sent >= size) {
          stop();
          controller.close();
        } else if ((controller.desiredSize ?? 1) <= 0) stdout.pause();
      };
      push(first);
      if (done) return;
      stdout.on('data', push);
      child.once('close', () => {
        if (done) return;
        stop();
        controller.error(new ComputerDockerError('failed', `The file ended after ${sent} of ${size} bytes`));
      });
      stdout.resume();
    },
    pull() {
      if (!done) stdout.resume();
    },
    cancel() {
      stop();
    },
  });
}

/** Open a download of one regular file (≤1 GiB) under the agent home. */
export async function openComputerDownload(
  userId: string,
  rawPath: string,
  deps: FilesDeps = defaultDeps,
): Promise<ComputerDownload> {
  const path = resolveMemberPath(rawPath, '');
  if (path === AGENT_HOME) throw new ComputerFileError('invalid', 'Not a regular file');
  const container = await deps.container(userId);
  let child: ChildProcess;
  try {
    child = deps
      .docker()
      .execStream(container, 'agent', ['sh', '-c', DOWNLOAD_SCRIPT, 'gh-download', path, String(DOWNLOAD_MAX_BYTES)], {
        cwd: AGENT_HOME,
        env: AGENT_ENV,
      });
  } catch (err) {
    return await rethrow(userId, err, deps);
  }
  child.stdin?.end();
  const deadline = setTimeout(() => child.kill('SIGKILL'), TRANSFER_TIMEOUT_MS);
  deadline.unref?.();
  const header = await readHeader(child);
  const announced = 'header' in header ? header.header.trim() : '';
  if (!('header' in header) || !/^\d{1,10}$/.test(announced) || Number(announced) > DOWNLOAD_MAX_BYTES) {
    clearTimeout(deadline);
    child.kill('SIGKILL');
    const failure =
      'header' in header
        ? new ComputerDockerError('failed', 'The computer did not say how large the file is')
        : scriptFailure(header.code, header.stderr, 'Reading the file');
    return await rethrow(userId, failure, deps);
  }
  void deps.touch(userId);
  const touching = setInterval(() => void deps.touch(userId), TOUCH_EVERY_MS);
  touching.unref?.();
  const stream = bodyStream(child, header.rest, Number(announced), () => {
    clearTimeout(deadline);
    clearInterval(touching);
    void deps.touch(userId);
  });
  return { name: posix.basename(path), size: Number(announced), stream };
}

// ─── Upload ───────────────────────────────────────────────

/**
 * Store `size` bytes from `body` in a folder of the agent home (default
 * ~/work) under a fresh name. `body` is the request stream (piped into the
 * container, never held whole in the API) or the bytes themselves.
 */
export async function uploadComputerFile(
  userId: string,
  input: { dir?: string; name: string; body: Readable | Buffer; size: number },
  deps: FilesDeps = defaultDeps,
): Promise<{ entry: ComputerFileEntry; path: string }> {
  const dir = resolveMemberPath(input.dir);
  const name = uploadFileName(input.name);
  if (!name) throw new ComputerFileError('invalid', 'That file name cannot be used');
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new ComputerFileError('invalid', 'Unknown upload size');
  }
  if (input.size > UPLOAD_MAX_BYTES) throw new ComputerFileError('too_large', 'Files up to 100 MiB can be uploaded');
  const container = await deps.container(userId);
  const touching = setInterval(() => void deps.touch(userId), TOUCH_EVERY_MS);
  touching.unref?.();
  try {
    const result = await deps.docker().exec({
      container,
      user: 'agent',
      cwd: AGENT_HOME,
      env: AGENT_ENV,
      argv: ['sh', '-c', UPLOAD_SCRIPT, 'gh-upload', dir, name.base, name.ext, String(input.size)],
      input: input.body,
      timeoutMs: TRANSFER_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024,
      maxStderrBytes: 4096,
    });
    // Killed (the client went away mid-upload, or the deadline) or cut short:
    // the script kept nothing, so there is nothing to clean up.
    if (result.code === null || result.code === EXIT.cutShort) {
      throw new ComputerFileError('invalid', 'The upload did not arrive complete; try again');
    }
    if (result.code !== 0) throw scriptFailure(result.code, result.stderr, 'Uploading the file');
    const [size, mtime, ...rest] = result.stdout.toString('utf8').replace(/\n$/, '').split('\t');
    const stored = rest.join('\t');
    if (!stored) throw new ComputerDockerError('failed', 'The computer did not say where the file went');
    return {
      entry: {
        name: stored,
        type: 'file',
        size: Number(size) || 0,
        mtime: new Date((Number(mtime) || 0) * 1000).toISOString(),
      },
      // The folder as the member named it (a symlinked folder keeps their path).
      path: posix.join(dir, stored),
    };
  } catch (err) {
    return await rethrow(userId, err, deps);
  } finally {
    clearInterval(touching);
    void deps.touch(userId);
  }
}
