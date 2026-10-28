#!/usr/bin/env node
/**
 * Leak guard for forks: every commit on top of upstream must stay inside the plugin seam,
 * and plugin code must use the public surface only.
 *
 * 1. Paths — fails when the diff against the upstream ref touches a file outside the allowed
 *    paths, so a private plugin can never silently grow into core: the fix for a real gap is
 *    a pull request upstream.
 * 2. Imports — files under plugins/ follow the package boundaries of scripts/lib/plugin-imports.mjs
 *    (reported as file:line; `--strict` makes them fail the run). Test files are exempt.
 *
 *   node scripts/check-extension-overlay.mjs                    # paths + imports vs $OVERLAY_UPSTREAM_REF or upstream/main
 *   node scripts/check-extension-overlay.mjs --base origin/main  # any ref (a bare ref argument works too)
 *   node scripts/check-extension-overlay.mjs --allow 'docs/**'   # extra allowed globs (repeatable)
 *   node scripts/check-extension-overlay.mjs --strict            # import violations fail too
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { checkPluginImports } from './lib/plugin-imports.mjs';

const args = process.argv.slice(2);
const extra = [];
let ref = process.env.OVERLAY_UPSTREAM_REF || 'upstream/main';
let strict = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow') extra.push(args[++i]);
  else if (args[i] === '--base') ref = args[++i];
  else if (args[i] === '--strict') strict = true;
  else ref = args[i];
}

/** Paths a fork may own outright. Everything else is upstream's: plugins are enabled in the config, not registered in core. */
const ALLOWED = [
  'greenhouse.config.ts',
  'plugins/**',
  'packs/**',
  'deploy/**',
  '.env.example',
  '.github/workflows/fork-*.yml',
  'README.fork.md',
  ...extra,
];

/**
 * Glob → RegExp for the allow-list.
 *
 * The `**` tokens are swapped for placeholders before single `*` is handled:
 * replacing them inline first would leave a `.*` whose own `*` the next rule
 * rewrites into `[^/]*`, quietly turning "any depth" into "one level".
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

function reportImports(files) {
  const violations = [];
  for (const file of files) {
    if (!existsSync(file)) continue; // deleted in the diff
    for (const v of checkPluginImports(file, readFileSync(file, 'utf8'))) violations.push({ file, ...v });
  }
  if (violations.length === 0) {
    console.log(`✓ plugin imports: ${files.length} file(s) stay inside the public surface`);
    return 0;
  }
  const log = strict ? console.error : console.warn;
  log(`${strict ? '✗' : '!'} ${violations.length} plugin import(s) past the public surface:`);
  for (const v of violations) log(`  ${v.file}:${v.line}  ${v.specifier}  — ${v.reason}`);
  if (!strict) log('(report mode — pass --strict to fail on these)');
  return strict ? 1 : 0;
}

const allowed = ALLOWED.map(globToRegExp);

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
const importStatus = reportImports(files.filter((f) => f.startsWith('plugins/')));
if (leaks.length === 0) {
  console.log(`✓ overlay is clean: ${files.length} file(s) differ from ${ref}, all inside the plugin seam`);
  process.exit(importStatus);
}
console.error(`✗ ${leaks.length} file(s) outside the plugin seam (diff against ${ref}):`);
for (const f of leaks) console.error(`  ${f}`);
console.error('\nMove private code into plugins/<id>/ or send the change upstream.');
process.exit(1);
