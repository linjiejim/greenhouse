/**
 * Sandbox toolchain inventory — PROBED, never declared.
 *
 * The agent has no way to know what the image ships with, and guessing costs
 * real money: a 2026-07-31 mission burned 29 minutes and 60 model requests
 * hand-rolling a JPEG extractor that `pdftoppm` would have done in one call.
 * So every session start writes the inventory into the workspace context file
 * that Pi reads (AGENTS.md).
 *
 * It is probed rather than hardcoded because runner and image are built
 * together but a workspace outlives both: a stale hardcoded list would keep
 * promising tools a rebuilt image had dropped, and the repo rule is that a
 * capability claim must be true. Probing also degrades correctly — an older
 * image simply advertises less.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const BLOCK_BEGIN = '<!-- greenhouse:toolchain:begin -->';
const BLOCK_END = '<!-- greenhouse:toolchain:end -->';

const BASE_CONTEXT =
  '# Cloud task workspace\n\n' +
  'You are running unattended in a disposable cloud sandbox. Work inside this directory.\n' +
  'End with a concise summary of what you did and what you produced.\n';

/**
 * The delivery contract, restated every run inside the managed block.
 *
 * It used to live in BASE_CONTEXT, which is only written when the file does
 * NOT exist. The workspace is persistent and the agent has full write access
 * to it, so one `write` to AGENTS.md (rather than an `edit`) erased this
 * sentence for that workspace FOREVER — every later run then wrote its report
 * to some other path, the collector only ever looks at `artifacts/`, and the
 * run still reported success. Keeping it inside the markers makes the loss
 * self-healing on the next run.
 */
const DELIVERY_CONTRACT = [
  '## Delivering files',
  '',
  'Place every final deliverable under `artifacts/` — **only files there are persisted for the user**.',
  'Anything written elsewhere in the workspace is working state and may be reclaimed.',
  'Write deliverables directly into `artifacts/` rather than moving them in at the end;',
  'copies that preserve their original timestamp are harder for the collector to recognize.',
];

/** Command name → what it is for. Probed in order; missing ones stay unlisted. */
const COMMAND_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['html2pdf', 'HTML → PDF: `html2pdf <in.html> <out.pdf>` (headless chromium, print CSS honoured)'],
  ['html2png', 'HTML → PNG: `html2png <in.html> <out.png> [width] [height]`, default 1600x900'],
  ['pdftotext', 'PDF → text; `pdftoppm` renders PDF pages to images (poppler)'],
  ['pandoc', 'convert between Markdown / HTML / docx / and friends'],
  ['convert', 'ImageMagick image processing (PDF/PS blocked by policy — use pdftoppm)'],
  ['chromium', 'headless browser, for anything the two wrappers above do not cover'],
  ['rg', 'ripgrep, fast content search'],
  ['jq', 'JSON processing'],
  ['git', 'version control'],
  ['unzip', 'archives: `unzip`/`zip`/`tar`/`xz`'],
];

/** pip name → import name, for the packages the image preinstalls. */
const PYTHON_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['pandas', 'pandas'],
  ['openpyxl', 'openpyxl'],
  ['python-docx', 'docx'],
  ['python-pptx', 'pptx'],
  ['pypdf', 'pypdf'],
  ['pillow', 'PIL'],
  ['requests', 'requests'],
  ['beautifulsoup4', 'bs4'],
  ['lxml', 'lxml'],
];

function onPath(command: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, command)));
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function installedPythonPackages(): string[] {
  if (!onPath('python3')) return [];
  const script =
    'import importlib.util,sys;print(" ".join(n for n,m in (a.split(":") for a in sys.argv[1:]) if importlib.util.find_spec(m)))';
  const out = run('python3', ['-c', script, ...PYTHON_PROBES.map(([pip, mod]) => `${pip}:${mod}`)]);
  return out ? out.trim().split(/\s+/).filter(Boolean) : [];
}

function hasCjkFonts(): boolean {
  if (!onPath('fc-list')) return false;
  return (run('fc-list', [':lang=zh']) ?? '').trim().length > 0;
}

/** The managed section, markers included. */
export function renderToolchainBlock(): string {
  const lines = [BLOCK_BEGIN, '', ...DELIVERY_CONTRACT, '', '## Preinstalled tools', ''];
  lines.push('Probed at container start, so this list is what the sandbox actually has.');
  lines.push('The system image is read-only: do not use `apt-get` or install into the system Python environment.');
  lines.push('Project-local dependencies may be installed under `/workspace` (for example npm `node_modules`).');
  lines.push('');

  for (const [command, description] of COMMAND_PROBES) {
    if (onPath(command)) lines.push(`- ${command} — ${description}`);
  }

  const python = installedPythonPackages();
  if (python.length > 0) {
    lines.push(`- python3 — preinstalled: ${python.join(', ')}`);
  } else if (onPath('python3')) {
    lines.push('- python3 — bare interpreter; the system Python environment is immutable');
  }

  if (hasCjkFonts()) {
    lines.push('- CJK fonts are installed, so rendered PDFs and screenshots show Chinese correctly.');
  }

  lines.push('', BLOCK_END, '');
  return lines.join('\n');
}

/**
 * Replace the managed block in `existing`, or append it. Everything outside the
 * markers is untouched: the workspace survives across runs and both the user
 * and the agent may have written project notes into this file.
 */
export function mergeToolchainBlock(existing: string, block: string): string {
  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return (
      existing.slice(0, start) + block.trimEnd() + '\n' + existing.slice(end + BLOCK_END.length).replace(/^\n/, '')
    );
  }
  return `${existing.trimEnd()}\n\n${block}`;
}

/**
 * Ensure the workspace context file exists and carries a current toolchain
 * section. Failure is non-fatal — a run without the inventory is merely less
 * informed, and must not be a run that never starts.
 */
export function ensureWorkspaceContext(path: string): void {
  try {
    let existing: string;
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      existing = BASE_CONTEXT;
    }
    writeFileSync(path, mergeToolchainBlock(existing, renderToolchainBlock()));
  } catch (err) {
    console.error('[runner] could not write workspace context file', err);
  }
}
