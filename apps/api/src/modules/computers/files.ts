/**
 * Files in the Agent's home, for the member whose computer it is: list a folder, download,
 * upload, delete. Everything runs as the `agent` user, the one the Agent's shell and the
 * member's terminal use, so the display and the browser's profile stay out of reach whatever a
 * path says.
 *
 * Paths are relative to the home (/home/agent). Absolute paths, `..` and control characters are
 * refused on the string; inside the computer the real path (`realpath -e`) must still be in the
 * home, so a link cannot lead out of it. Paths and names reach the computer as arguments, never
 * as script text.
 */

import { cleanName } from '../files/service.js';
import type { ComputerFile } from '@greenhouse/contract';
import { ApiError, invalidInput, notFound } from '../../http/errors.js';

export const AGENT_HOME = '/home/agent';
export const LIST_MAX_ENTRIES = 500;
export const DOWNLOAD_MAX_BYTES = 1024 ** 3;
/** Folders the computer itself needs: the Agent's shell starts in work, the browser saves into Downloads. */
const KEPT_FOLDERS = ['work', 'Downloads'];
/** Longest name an upload keeps, in UTF-8 bytes (file systems allow 255; " (999)" needs room). */
const MAX_NAME_BYTES = 200;
/** Uploads in flight, never listed. */
const UPLOAD_TEMP_PREFIX = '.gh-upload.';

/** A path in the home: `rel` as the member sees it, `abs` as the computer does. */
export interface HomePath {
  rel: string;
  abs: string;
}

/** The member's path, checked on the string: relative to the home, never above it. */
export function homePath(raw: string): HomePath {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw invalidInput('That path is not valid.');
  if (raw.startsWith('/')) {
    throw new ApiError(400, 'path_outside_home', 'Paths are relative to the home folder.');
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new ApiError(400, 'path_outside_home', 'Paths cannot leave the home folder.');
  const rel = parts.join('/');
  return { rel, abs: rel ? `${AGENT_HOME}/${rel}` : AGENT_HOME };
}

/** `report.final.pdf` → `report.final` + `.pdf`; a leading dot belongs to the name (`.env`). */
export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** The name an upload is stored under before de-duplication: a plain name that fits the file system. */
export function uploadName(raw: string): { base: string; ext: string } {
  let clean = cleanName(raw);
  if (clean === '.' || clean === '..' || clean.startsWith(UPLOAD_TEMP_PREFIX)) clean = 'file';
  let { base, ext } = splitName(clean);
  if (Buffer.byteLength(ext) > 32) [base, ext] = [clean, ''];
  while (base && Buffer.byteLength(base + ext) > MAX_NAME_BYTES) base = [...base].slice(0, -1).join('');
  base = base.trim();
  return base ? { base, ext } : { base: 'file', ext };
}

/** Exit codes the scripts share; anything else is the computer failing. */
const EXIT = { notFound: 3, wrongKind: 4, outside: 5, denied: 6, tooLarge: 7, cutShort: 8 } as const;

/** `$r` = the real path of `$1`, which must exist and stay in the home. */
const REALPATH = [
  'r=$(realpath -e -- "$1" 2>/dev/null) || { echo "No such file or folder." >&2; exit 3; }',
  'case "$r" in /home/agent|/home/agent/*) ;; *) echo "That leads out of the home folder." >&2; exit 5 ;; esac',
];

/** `$1` folder, `$2` most entries → folders, then the rest, each by name: `type \t size \t mtime \t name`, NUL-ended. */
export const LIST_SCRIPT = [
  ...REALPATH,
  '[ -d "$r" ] || { echo "Not a folder." >&2; exit 4; }',
  '[ -r "$r" ] && [ -x "$r" ] || { echo "Permission denied." >&2; exit 6; }',
  'tab=$(printf "\\t")',
  'fmt="%y\\t%s\\t%T@\\t%f\\0"',
  '{ find -L "$r" -mindepth 1 -maxdepth 1 -type d -printf "$fmt" 2>/dev/null | LC_ALL=C sort -z -t "$tab" -k4',
  '  find -L "$r" -mindepth 1 -maxdepth 1 ! -type d -printf "$fmt" 2>/dev/null | LC_ALL=C sort -z -t "$tab" -k4',
  '} | head -z -n "$(($2 + 1))"',
].join('\n');

/** `$1` file, `$2` most bytes → its size on one line, then exactly that many of its bytes. */
export const DOWNLOAD_SCRIPT = [
  ...REALPATH,
  '[ -f "$r" ] || { echo "Not a file." >&2; exit 4; }',
  '[ -r "$r" ] || { echo "Permission denied." >&2; exit 6; }',
  's=$(stat -c %s -- "$r") || exit 3',
  '[ "$s" -le "$2" ] || { echo "The file is larger than 1 GB." >&2; exit 7; }',
  'printf "%s\\n" "$s"',
  'exec head -c "$s" -- "$r"',
].join('\n');

/**
 * `$1` folder, `$2` base, `$3` extension, `$4` byte count; stdin = the file. The bytes land in a
 * hidden temporary file, which moves onto the first free name only once complete: an upload
 * never overwrites anything (`name (1).ext` …). Prints `size \t mtime \t name`.
 */
export const UPLOAD_SCRIPT = [
  ...REALPATH,
  '[ -d "$r" ] || { echo "Not a folder." >&2; exit 4; }',
  `tmp=$(mktemp -p "$r" ${UPLOAD_TEMP_PREFIX}XXXXXXXX 2>/dev/null) || { echo "Cannot write to that folder." >&2; exit 6; }`,
  'trap \'rm -f -- "$tmp"\' EXIT',
  'head -c "$4" >"$tmp"',
  'got=$(stat -c %s -- "$tmp")',
  '[ "$got" = "$4" ] || { echo "The upload stopped after $got of $4 bytes." >&2; exit 8; }',
  'chmod 0644 -- "$tmp"',
  'name="$2$3"; i=0',
  'until ( set -C; : >"$r/$name" ) 2>/dev/null; do',
  '  [ -e "$r/$name" ] || [ -L "$r/$name" ] || { echo "Cannot write to that folder." >&2; exit 6; }',
  '  i=$((i + 1))',
  '  [ "$i" -lt 1000 ] || { echo "No free file name is left." >&2; exit 6; }',
  '  name="$2 ($i)$3"',
  'done',
  'mv -f -- "$tmp" "$r/$name" || { rm -f -- "$r/$name"; echo "Cannot write to that folder." >&2; exit 6; }',
  'printf "%s\\t%s\\t%s\\n" "$got" "$(stat -c %Y -- "$r/$name")" "$name"',
].join('\n');

/**
 * `$1` path → deleted, a folder with everything in it. A link goes, never what it points to; the
 * folder holding it must be in the home. The folders the computer needs stay.
 */
export const DELETE_SCRIPT = [
  'p=$(realpath -e -- "$(dirname -- "$1")" 2>/dev/null) || { echo "No such file or folder." >&2; exit 3; }',
  'case "$p" in /home/agent|/home/agent/*) ;; *) echo "That leads out of the home folder." >&2; exit 5 ;; esac',
  't="$p/$(basename -- "$1")"',
  '[ -e "$t" ] || [ -L "$t" ] || { echo "No such file or folder." >&2; exit 3; }',
  `case "$t" in ${KEPT_FOLDERS.map((name) => `${AGENT_HOME}/${name}`).join('|')}) echo "The computer needs this folder; delete what is in it instead." >&2; exit 4 ;; esac`,
  'rm -rf -- "$t" 2>/dev/null',
  '[ ! -e "$t" ] && [ ! -L "$t" ] || { echo "Permission denied." >&2; exit 6; }',
].join('\n');

/** argv that runs one of the scripts above with its arguments. */
export const scriptArgv = (script: string, args: string[]) => ['sh', '-c', script, 'gh-files', ...args];

/** A script's exit as the error the route answers with. */
export function scriptError(code: number | null, stderr: string): ApiError {
  const message = stderr.trim().split('\n').pop()?.slice(0, 300) || 'The computer could not do that.';
  switch (code) {
    case EXIT.notFound:
      return notFound('File or folder');
    case EXIT.wrongKind:
    case EXIT.denied:
      return invalidInput(message);
    case EXIT.outside:
      return new ApiError(400, 'path_outside_home', message);
    case EXIT.tooLarge:
      return new ApiError(413, 'too_large', message);
    case EXIT.cutShort:
      return new ApiError(400, 'upload_incomplete', message);
    default:
      return new ApiError(502, 'computer_error', message);
  }
}

/** The list script's records as entries; records it cannot read are skipped. */
export function parseListing(stdout: string, max = LIST_MAX_ENTRIES): { items: ComputerFile[]; truncated: boolean } {
  const items: ComputerFile[] = [];
  let seen = 0;
  for (const record of stdout.split('\0')) {
    const parts = record.split('\t');
    if (parts.length < 4) continue;
    const [kind, size, mtime] = parts;
    const name = parts.slice(3).join('\t');
    if (!name || name.startsWith(UPLOAD_TEMP_PREFIX)) continue;
    seen++;
    if (items.length >= max) continue;
    const dir = kind === 'd';
    const seconds = Number(mtime);
    items.push({
      name,
      type: dir ? 'dir' : 'file',
      size: dir ? 0 : Math.max(0, Math.floor(Number(size)) || 0),
      modified_at: new Date(Number.isFinite(seconds) ? seconds * 1000 : 0).toISOString(),
    });
  }
  return { items, truncated: seen > max };
}

/** The upload script's line: `size \t mtime \t name`. */
export function parseUploaded(stdout: string): ComputerFile | null {
  const [size, mtime, ...rest] = stdout.replace(/\n$/, '').split('\t');
  const name = rest.join('\t');
  if (!name || !size || !mtime) return null;
  return {
    name,
    type: 'file',
    size: Math.max(0, Number(size) || 0),
    modified_at: new Date(Number(mtime) * 1000).toISOString(),
  };
}
