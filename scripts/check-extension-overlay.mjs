#!/usr/bin/env node
/**
 * Leak guard for forks: every commit on top of upstream must stay inside the
 * extension seam. Fails when the diff against the upstream ref touches a file
 * outside the allowed paths, so a private module can never silently grow into
 * core — the fix for a real gap is a pull request upstream, not a local patch.
 *
 *   node scripts/check-extension-overlay.mjs                 # against upstream/main
 *   node scripts/check-extension-overlay.mjs origin/main      # any ref
 *   node scripts/check-extension-overlay.mjs --allow docs/**  # extra globs (repeatable)
 *
 * Run it in the fork's CI; upstream itself has nothing to check.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const extra = [];
let ref = 'upstream/main';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow') extra.push(args[++i]);
  else ref = args[i];
}

/** Paths a fork may own outright. Everything else is upstream's. */
const ALLOWED = [
  'apps/api/src/extensions/**',
  'apps/web/src/extensions/**',
  'greenhouse.config.ts',
  'packs/**',
  'deploy/**',
  '.env.example',
  '.github/workflows/fork-*.yml',
  'README.fork.md',
  ...extra,
];

/** The two list files are the only core files a fork edits: one import line per extension. */
const ONE_LINE_REGISTRATION = ['apps/api/src/extensions/index.ts', 'apps/web/src/extensions/index.ts'];

/**
 * Glob → RegExp for the allow-list.
 *
 * The `**` tokens are swapped for placeholders before single `*` is handled:
 * replacing them inline first would leave a `.*` whose own `*` the next rule
 * rewrites into `[^/]*`, quietly turning "any depth" into "one level" — which
 * is how this guard passed while a nested extension file went unchecked.
 */
function globToRegExp(glob) {
  const DOUBLE_SLASH = '\u0000';
  const DOUBLE = '\u0001';
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DOUBLE_SLASH)
    .replace(/\*\*/g, DOUBLE)
    .replace(/\*/g, '[^/]*')
    .split(DOUBLE_SLASH)
    .join('(?:.*/)?')
    .split(DOUBLE)
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

const allowed = [...ALLOWED, ...ONE_LINE_REGISTRATION].map(globToRegExp);

let files;
try {
  files = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], { encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
} catch (err) {
  console.error(`Cannot diff against ${ref}: ${err instanceof Error ? err.message : err}`);
  console.error(
    'Add the upstream remote first: git remote add upstream https://github.com/linjiejim/greenhouse.git && git fetch upstream',
  );
  process.exit(2);
}

const leaks = files.filter((f) => !allowed.some((re) => re.test(f)));
if (leaks.length === 0) {
  console.log(`✓ overlay is clean: ${files.length} file(s) differ from ${ref}, all inside the extension seam`);
  process.exit(0);
}
console.error(`✗ ${leaks.length} file(s) outside the extension seam (diff against ${ref}):`);
for (const f of leaks) console.error(`  ${f}`);
console.error('\nMove private code under apps/*/src/extensions/<id>/ or send the change upstream.');
process.exit(1);
