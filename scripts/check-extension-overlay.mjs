#!/usr/bin/env node
/**
 * Leak guard for forks: every commit on top of upstream must stay inside the
 * extension seam, and extension code must use the public surface only.
 *
 * 1. Paths — fails when the diff against the upstream ref touches a file
 *    outside the allowed paths, so a private module can never silently grow
 *    into core: the fix for a real gap is a pull request upstream.
 * 2. Import edges — a file under apps/{api,web}/src/extensions/<id>/ may import
 *    only its own directory (or another extension's), its app's extension-kit,
 *    @greenhouse/types/*, @greenhouse/crud and third-party packages. Test files
 *    are exempt. Reported as file:line; `--strict` makes them fail the run.
 *
 *   node scripts/check-extension-overlay.mjs                    # paths + imports vs $OVERLAY_UPSTREAM_REF or upstream/main
 *   node scripts/check-extension-overlay.mjs --base origin/main  # any ref (a bare ref argument works too)
 *   node scripts/check-extension-overlay.mjs --allow 'docs/**'   # extra allowed globs (repeatable)
 *   node scripts/check-extension-overlay.mjs --strict            # import violations fail too
 *   node scripts/check-extension-overlay.mjs --all --strict      # imports of every extension in the tree, no diff
 *                                                                # (upstream CI runs this against the example)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkFileImports, extensionFileInfo } from './lib/extension-imports.mjs';

const args = process.argv.slice(2);
const extra = [];
let ref = process.env.OVERLAY_UPSTREAM_REF || 'upstream/main';
let strict = false;
let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow') extra.push(args[++i]);
  else if (args[i] === '--base') ref = args[++i];
  else if (args[i] === '--strict') strict = true;
  else if (args[i] === '--all') all = true;
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

/** Every file under apps/{api,web}/src/extensions/<id>/ in the working tree. */
function treeExtensionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path.split('\\').join('/'));
    }
  };
  for (const app of ['api', 'web']) {
    const root = `apps/${app}/src/extensions`;
    if (existsSync(root)) walk(root);
  }
  return out.filter((file) => extensionFileInfo(file));
}

function reportImports(files) {
  const violations = [];
  for (const file of files) {
    if (!existsSync(file)) continue; // deleted in the diff
    for (const v of checkFileImports(file, readFileSync(file, 'utf8'))) violations.push({ file, ...v });
  }
  if (violations.length === 0) {
    console.log(`✓ extension imports: ${files.length} file(s) use only their own code, the kit and allowed packages`);
    return 0;
  }
  const log = strict ? console.error : console.warn;
  log(`${strict ? '✗' : '!'} ${violations.length} extension import(s) past the public surface:`);
  for (const v of violations) log(`  ${v.file}:${v.line}  ${v.specifier}  — ${v.reason}`);
  if (!strict) log('(report mode — pass --strict to fail on these)');
  return strict ? 1 : 0;
}

if (all) {
  process.exit(reportImports(treeExtensionFiles()));
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
const importStatus = reportImports(files.filter((f) => extensionFileInfo(f)));
if (leaks.length === 0) {
  console.log(`✓ overlay is clean: ${files.length} file(s) differ from ${ref}, all inside the extension seam`);
  process.exit(importStatus);
}
console.error(`✗ ${leaks.length} file(s) outside the extension seam (diff against ${ref}):`);
for (const f of leaks) console.error(`  ${f}`);
console.error('\nMove private code under apps/*/src/extensions/<id>/ or send the change upstream.');
process.exit(1);
