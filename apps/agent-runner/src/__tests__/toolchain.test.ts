import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureWorkspaceContext, mergeToolchainBlock, renderToolchainBlock } from '../toolchain.js';

const BEGIN = '<!-- greenhouse:toolchain:begin -->';
const END = '<!-- greenhouse:toolchain:end -->';

let scratch: string;
let originalPath: string | undefined;
let pathCounter: number;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'toolchain-'));
  originalPath = process.env.PATH;
  pathCounter = 0;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(scratch, { recursive: true, force: true });
});

/** A PATH holding exactly the given commands — each call gets a fresh bin dir. */
function fakePath(...commands: string[]): string {
  const bin = join(scratch, `bin-${pathCounter++}`);
  mkdirSync(bin, { recursive: true });
  for (const command of commands) writeFileSync(join(bin, command), '', { mode: 0o755 });
  return bin;
}

describe('renderToolchainBlock', () => {
  it('advertises only the commands actually on PATH', () => {
    process.env.PATH = fakePath('html2pdf', 'jq');

    const block = renderToolchainBlock();

    expect(block).toContain(BEGIN);
    expect(block).toContain(END);
    expect(block).toContain('- html2pdf —');
    expect(block).toContain('- jq —');
    // The whole point: a tool the image does not ship must never be promised.
    expect(block).not.toContain('- pandoc —');
    expect(block).not.toContain('- chromium —');
    expect(block).not.toContain('- python3 —');
    expect(block).toContain('system image is read-only');
    expect(block).not.toContain('apt-get install');
  });

  it('promises nothing when the sandbox has an empty PATH', () => {
    process.env.PATH = fakePath();

    const block = renderToolchainBlock();

    expect(block).toContain(BEGIN);
    expect(block).not.toContain('- pdftotext —');
    expect(block).not.toContain('- html2pdf —');
  });
});

describe('mergeToolchainBlock', () => {
  it('appends the block when the file has none', () => {
    const merged = mergeToolchainBlock('# Notes\n\nkeep me\n', `${BEGIN}\nfresh\n${END}\n`);

    expect(merged).toContain('keep me');
    expect(merged).toContain('fresh');
  });

  it('replaces a stale block and keeps the text on both sides', () => {
    const existing = `# Notes\n\nbefore\n\n${BEGIN}\nstale inventory\n${END}\n\nafter\n`;

    const merged = mergeToolchainBlock(existing, `${BEGIN}\nfresh inventory\n${END}\n`);

    expect(merged).toContain('before');
    expect(merged).toContain('after');
    expect(merged).toContain('fresh inventory');
    expect(merged).not.toContain('stale inventory');
    expect(merged.split(BEGIN)).toHaveLength(2);
  });

  it('is idempotent, so a workspace re-run does not stack blocks', () => {
    const block = `${BEGIN}\ninventory\n${END}\n`;
    const once = mergeToolchainBlock('# Notes\n', block);

    expect(mergeToolchainBlock(once, block)).toBe(once);
  });
});

describe('ensureWorkspaceContext', () => {
  it('creates the context file with the deliverable convention and the inventory', () => {
    process.env.PATH = fakePath('html2pdf');
    const path = join(scratch, 'AGENTS.md');

    ensureWorkspaceContext(path);

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('artifacts/');
    expect(written).toContain('- html2pdf —');
  });

  it('refreshes the inventory across runs without losing project notes', () => {
    const path = join(scratch, 'AGENTS.md');
    process.env.PATH = fakePath('html2pdf');
    ensureWorkspaceContext(path);

    writeFileSync(path, `${readFileSync(path, 'utf8')}\n## Project notes\n\nthe user typed this\n`);
    // Second run on a rebuilt image that dropped html2pdf and gained jq.
    process.env.PATH = fakePath('jq');
    ensureWorkspaceContext(path);

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('the user typed this');
    expect(written).toContain('- jq —');
    expect(written).not.toContain('- html2pdf —');
  });

  /**
   * The workspace is persistent and the agent can write anywhere in it. When
   * the delivery contract lived outside the managed markers, one `write` to
   * AGENTS.md erased it for that workspace permanently — every later run then
   * put its report somewhere the collector never looks, and still reported
   * success. Restoring it must be automatic.
   */
  it('restores the delivery contract after the agent overwrites the whole file', () => {
    const path = join(scratch, 'AGENTS.md');
    process.env.PATH = fakePath('jq');
    ensureWorkspaceContext(path);
    expect(readFileSync(path, 'utf8')).toContain('artifacts/');

    writeFileSync(path, '# My own notes\n\nnothing about deliverables here\n');
    ensureWorkspaceContext(path);

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('artifacts/');
    expect(written).toContain('My own notes');
  });
});
