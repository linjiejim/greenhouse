/**
 * Regression matrix for the four silent drops that made "the agent wrote it,
 * the user never got it" possible. Each case here was a real path that
 * produced a `completed` run with a shorter artifact list and no explanation.
 */

import { describe, it, expect } from 'vitest';
import type { Dirent, Stats } from 'node:fs';

import { collectArtifacts, guessContentType } from '../artifacts.js';

const ROOT = '/workspace/artifacts';
const NOW = 1_700_000_000_000;

type Node = { kind: 'file' | 'dir' | 'symlink'; mtimeMs?: number; size?: number; target?: 'file' | 'dir' | 'other' };

/** Minimal in-memory fs: absolute path → node. Directories list their children. */
function fakeFs(tree: Record<string, Node>, opts: { unreadableDirs?: string[] } = {}) {
  const unreadable = new Set(opts.unreadableDirs ?? []);
  return {
    readdirSync: (dir: string): Dirent[] => {
      if (unreadable.has(dir)) throw new Error('EACCES: permission denied');
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const path of Object.keys(tree)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest.length === 0) continue;
        names.add(rest.split('/')[0]!);
      }
      return [...names].map((name) => {
        const node = tree[`${prefix}${name}`];
        return {
          name,
          isDirectory: () => node?.kind === 'dir',
          isFile: () => node?.kind === 'file',
          isSymbolicLink: () => node?.kind === 'symlink',
        } as Dirent;
      });
    },
    statSync: (path: string): Stats => {
      const node = tree[path];
      if (!node) throw new Error(`ENOENT: ${path}`);
      const resolved = node.kind === 'symlink' ? (node.target ?? 'file') : node.kind;
      return {
        mtimeMs: node.mtimeMs ?? NOW,
        size: node.size ?? 10,
        isFile: () => resolved === 'file',
        isDirectory: () => resolved === 'dir',
      } as Stats;
    },
  };
}

function collect(tree: Record<string, Node>, opts: { unreadableDirs?: string[]; maxFiles?: number } = {}) {
  return collectArtifacts({
    root: ROOT,
    freshSinceMs: NOW - 5_000,
    maxFiles: opts.maxFiles ?? 50,
    maxBytes: 20 * 1024 * 1024,
    fs: fakeFs(tree, opts),
  });
}

describe('collectArtifacts', () => {
  it('collects fresh regular files, including nested ones', () => {
    const { upload, skipped } = collect({
      [`${ROOT}/report.pdf`]: { kind: 'file', size: 100 },
      [`${ROOT}/data`]: { kind: 'dir' },
      [`${ROOT}/data/rows.csv`]: { kind: 'file', size: 50 },
    });
    expect(upload.map((f) => f.path)).toEqual(['data/rows.csv', 'report.pdf']);
    expect(skipped).toEqual([]);
  });

  it('reports a stale mtime instead of dropping it silently (mv/unzip preserve timestamps)', () => {
    const { upload, skipped } = collect({
      [`${ROOT}/old-report.pdf`]: { kind: 'file', mtimeMs: NOW - 86_400_000 },
    });
    expect(upload).toEqual([]);
    expect(skipped).toEqual([{ path: 'old-report.pdf', reason: 'stale_mtime' }]);
  });

  it('applies the ceiling AFTER the freshness filter, so stale files cannot squeeze out new work', () => {
    const tree: Record<string, Node> = {};
    // A persistent workspace: 3 old deliverables sort ahead of the new one.
    for (let i = 0; i < 3; i++) tree[`${ROOT}/a-old-${i}.txt`] = { kind: 'file', mtimeMs: NOW - 86_400_000 };
    tree[`${ROOT}/z-new.txt`] = { kind: 'file' };

    const { upload, skipped } = collect(tree, { maxFiles: 2 });
    expect(upload.map((f) => f.path)).toEqual(['z-new.txt']);
    expect(skipped.every((s) => s.reason === 'stale_mtime')).toBe(true);
  });

  it('reports overflow past the ceiling rather than truncating in silence', () => {
    const tree: Record<string, Node> = {};
    for (let i = 0; i < 4; i++) tree[`${ROOT}/file-${i}.txt`] = { kind: 'file' };

    const { upload, skipped } = collect(tree, { maxFiles: 2 });
    expect(upload).toHaveLength(2);
    expect(skipped).toEqual([
      { path: 'file-2.txt', reason: 'over_limit' },
      { path: 'file-3.txt', reason: 'over_limit' },
    ]);
  });

  it('keeps the newest work when the ceiling bites', () => {
    const { upload, skipped } = collect(
      {
        [`${ROOT}/a-older.txt`]: { kind: 'file', mtimeMs: NOW - 1_000 },
        [`${ROOT}/z-newest.txt`]: { kind: 'file', mtimeMs: NOW },
      },
      { maxFiles: 1 },
    );
    // Alphabetically 'a-older' sorts first; recency has to win over the name.
    expect(upload.map((f) => f.path)).toEqual(['z-newest.txt']);
    expect(skipped).toEqual([{ path: 'a-older.txt', reason: 'over_limit' }]);
  });

  it('keeps the files it already found when one subdirectory is unreadable', () => {
    const { upload, skipped } = collect(
      {
        [`${ROOT}/report.pdf`]: { kind: 'file' },
        [`${ROOT}/locked`]: { kind: 'dir' },
        [`${ROOT}/locked/secret.txt`]: { kind: 'file' },
      },
      { unreadableDirs: [`${ROOT}/locked`] },
    );
    // Previously one throw returned [] and the run reported artifacts: 0.
    expect(upload.map((f) => f.path)).toEqual(['report.pdf']);
    expect(skipped).toEqual([{ path: 'locked', reason: 'walk_error', detail: expect.stringContaining('EACCES') }]);
  });

  it('refuses a symlink to a regular file', () => {
    const { upload, skipped } = collect({
      [`${ROOT}/big.pdf`]: { kind: 'symlink', target: 'file', size: 999 },
    });
    expect(upload).toEqual([]);
    expect(skipped).toEqual([{ path: 'big.pdf', reason: 'unreadable', detail: 'symbolic links are not allowed' }]);
  });

  it('refuses every symlink without inspecting its target', () => {
    const { upload, skipped } = collect({
      [`${ROOT}/sock`]: { kind: 'symlink', target: 'other' },
    });
    expect(upload).toEqual([]);
    expect(skipped[0]).toMatchObject({ path: 'sock', reason: 'unreadable' });
  });

  it('reports oversize files', () => {
    const { upload, skipped } = collect({
      [`${ROOT}/huge.zip`]: { kind: 'file', size: 21 * 1024 * 1024 },
    });
    expect(upload).toEqual([]);
    expect(skipped[0]).toMatchObject({ path: 'huge.zip', reason: 'too_large' });
  });

  it('returns empty without throwing when the artifacts dir does not exist', () => {
    expect(collect({})).toEqual({ upload: [], skipped: [] });
  });
});

describe('guessContentType', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(guessContentType('a/b/report.pdf')).toBe('application/pdf');
    expect(guessContentType('notes.MD')).toBe('text/markdown');
    expect(guessContentType('mystery')).toBe('application/octet-stream');
  });
});
