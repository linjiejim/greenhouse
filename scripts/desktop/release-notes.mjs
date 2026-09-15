#!/usr/bin/env node
/**
 * Release notes for a web bundle — what the shell's "what's new" dialog shows.
 *
 * Written into `public/` so they travel INSIDE the signed bundle: version, UI and
 * notes cannot be replaced independently of each other. Two sources, in order:
 *
 *   1. a curated file, `GREENHOUSE_WEB_BUNDLE_NOTES_FILE` (a deployment that wants
 *      to write its own notes points this at a JSON file of the same shape);
 *   2. otherwise the commit subjects since the previous bundle, capped at six,
 *      which is what a routine release reads like anyway.
 *
 * Shape (schemaVersion 1; the shell validates it in `web_bundle.rs`):
 *   { schemaVersion, appVersion, webBundleVersion, title, summary, changes[], releasedAt }
 *
 *   node scripts/desktop/release-notes.mjs            # writes public/release-notes.json (+ history)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWebBundleVersion } from './web-bundle-version.mjs';

const TITLE_MAX = 40;
const SUMMARY_MAX = 100;
const CHANGE_MAX = 80;
const CHANGES_MAX = 6;

function clip(text, max) {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** Commit subjects of the last `limit` commits, oldest first. */
function recentSubjects(cwd, limit) {
  const out = execFileSync('git', ['log', `-n${limit}`, '--format=%s', '--no-merges'], { cwd, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
}

/** Build the notes document for one bundle. Pure apart from `git log`. */
export function buildReleaseNotes({ appVersion, webBundleVersion, cwd, curatedPath, now = new Date() }) {
  if (curatedPath) {
    const curated = JSON.parse(readFileSync(curatedPath, 'utf8'));
    return {
      ...curated,
      schemaVersion: 1,
      appVersion,
      webBundleVersion,
      releasedAt: curated.releasedAt ?? now.toISOString(),
    };
  }
  const subjects = recentSubjects(cwd, CHANGES_MAX);
  const changes = (subjects.length > 0 ? subjects : ['Maintenance update']).map((s) => clip(s, CHANGE_MAX));
  return {
    schemaVersion: 1,
    appVersion,
    webBundleVersion,
    title: clip(`Greenhouse ${appVersion}`, TITLE_MAX),
    summary: clip(changes[changes.length - 1], SUMMARY_MAX),
    changes,
    releasedAt: now.toISOString(),
  };
}

/** Validate against the shell's contract; returns the list of violations. */
export function releaseNotesProblems(notes, { appVersion, webBundleVersion }) {
  const problems = [];
  if (notes.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (String(notes.webBundleVersion) !== String(webBundleVersion)) problems.push('webBundleVersion mismatch');
  if (String(notes.appVersion) !== String(appVersion)) problems.push('appVersion mismatch');
  if (typeof notes.title !== 'string' || !notes.title.trim() || [...notes.title].length > TITLE_MAX)
    problems.push('title');
  if (typeof notes.summary !== 'string' || !notes.summary.trim() || [...notes.summary].length > SUMMARY_MAX)
    problems.push('summary');
  if (!Array.isArray(notes.changes) || notes.changes.length < 1 || notes.changes.length > CHANGES_MAX)
    problems.push('changes');
  else if (notes.changes.some((c) => typeof c !== 'string' || !c.trim() || [...c].length > CHANGE_MAX))
    problems.push('changes[]');
  if (typeof notes.releasedAt !== 'string' || Number.isNaN(Date.parse(notes.releasedAt))) problems.push('releasedAt');
  return problems;
}

/** Write `release-notes.json` and `release-notes-history.json` into `publicDir`. */
export function writeReleaseNotes({ repoRoot, publicDir, env = process.env }) {
  const appVersion = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
  const webBundleVersion = resolveWebBundleVersion(env, repoRoot);
  const curatedPath = env.GREENHOUSE_WEB_BUNDLE_NOTES_FILE
    ? resolve(repoRoot, env.GREENHOUSE_WEB_BUNDLE_NOTES_FILE)
    : undefined;
  if (curatedPath && !existsSync(curatedPath))
    throw new Error(`GREENHOUSE_WEB_BUNDLE_NOTES_FILE not found: ${curatedPath}`);
  const notes = buildReleaseNotes({ appVersion, webBundleVersion, cwd: repoRoot, curatedPath });
  const problems = releaseNotesProblems(notes, { appVersion, webBundleVersion });
  if (problems.length > 0) throw new Error(`release notes are invalid: ${problems.join(', ')}`);
  writeFileSync(resolve(publicDir, 'release-notes.json'), `${JSON.stringify(notes, null, 2)}\n`);
  // The dialog browses history; a generated bundle knows only itself.
  writeFileSync(resolve(publicDir, 'release-notes-history.json'), `${JSON.stringify([notes], null, 2)}\n`);
  return notes;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const publicDir = resolve(repoRoot, 'public');
  if (!existsSync(resolve(publicDir, 'index.html'))) {
    console.error('✗ public/index.html is missing — run `pnpm web:build` first.');
    process.exit(1);
  }
  const notes = writeReleaseNotes({ repoRoot, publicDir });
  console.log(`✅ release notes for web bundle v${notes.webBundleVersion}: ${notes.title}`);
}
