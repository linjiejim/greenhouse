#!/usr/bin/env node
/**
 * Assemble the shell release manifests from every platform's fragment.
 *
 * The counterpart to `make-app-release.mjs`: that script collects one platform's
 * artifacts on the machine that built them; this one runs wherever all fragments
 * have been gathered (CI: the publish-app job after downloading both build
 * artifacts; locally: after rsync/copying fragment dirs together) and writes the
 * two documents every client trusts:
 *
 *   latest.json     tauri-plugin-updater feed (all platforms in one document)
 *   downloads.json  web download card + publish idempotency check
 *
 * Atomic by default: a missing expected platform fails the merge, because a
 * half-populated manifest either lies to the missing platform (no entry → the
 * in-shell update card silently disappears) or points at files that were never
 * uploaded. `--allow-missing` is the explicit single-platform escape hatch for
 * emergency hand publishes.
 *
 *   node scripts/desktop/merge-app-release.mjs --channel stable
 *     [--artifact-base <url>]   where the files will be served from; defaults to
 *                              `$GREENHOUSE_DESKTOP_UPDATE_BASE/<channel>/app`
 *     [--dir apps/desktop/release/app]
 *     [--require darwin-aarch64,windows-x86_64]
 *     [--allow-missing]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactBaseFor,
  buildAppReleaseManifests,
  CHANNELS,
  platformArtifactNames,
} from './app-release-manifests.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const channel = argValue('--channel');
if (!CHANNELS.includes(channel ?? '')) fail(`--channel must be one of ${CHANNELS.join('/')}, got ${channel}`);
const dir = resolve(repoRoot, argValue('--dir') ?? 'apps/desktop/release/app');
const required = (argValue('--require') ?? 'darwin-aarch64,windows-x86_64').split(',').filter(Boolean);
const allowMissing = process.argv.includes('--allow-missing');
const artifactBaseUrl =
  argValue('--artifact-base') ??
  (process.env.GREENHOUSE_DESKTOP_UPDATE_BASE
    ? artifactBaseFor(process.env.GREENHOUSE_DESKTOP_UPDATE_BASE, channel)
    : undefined);
if (!artifactBaseUrl) {
  fail(
    'pass --artifact-base <url> or set GREENHOUSE_DESKTOP_UPDATE_BASE — the manifests carry absolute artifact URLs.',
  );
}

// ── Read the fragments ──

const fragmentNames = existsSync(dir)
  ? readdirSync(dir)
      .filter((name) => /^fragment-.+\.json$/.test(name))
      .sort()
  : [];
if (fragmentNames.length === 0) fail(`no fragment-*.json under ${dir} — run make-app-release.mjs first.`);

const fragments = fragmentNames.map((name) => {
  const fragment = JSON.parse(readFileSync(resolve(dir, name), 'utf-8'));
  if (fragment.schemaVersion !== 1) fail(`${name}: unknown schemaVersion ${fragment.schemaVersion}`);
  if (name !== `fragment-${fragment.platformKey}.json`) {
    fail(`${name}: file name does not match its platformKey ${fragment.platformKey}`);
  }
  return fragment;
});

const missing = required.filter((key) => !fragments.some((fragment) => fragment.platformKey === key));
if (missing.length > 0 && !allowMissing) {
  fail(
    `missing platform fragment(s): ${missing.join(', ')} — a partial manifest would lie to those platforms. ` +
      'Pass --allow-missing only for an explicit single-platform emergency publish.',
  );
}
if (missing.length > 0) console.warn(`⚠ publishing WITHOUT: ${missing.join(', ')} (--allow-missing)`);

// Version fields are release identity: fragments from different commits must
// never merge. releasedAt/notes may drift (a fallback timestamp when
// release-notes.json is absent), so they are taken from the first fragment.
const [head, ...rest] = fragments;
for (const fragment of rest) {
  for (const field of ['version', 'nativeApiVersion']) {
    if (fragment[field] !== head[field]) {
      fail(
        `${fragment.platformKey} ${field} ${fragment[field]} != ${head.platformKey} ${field} ${head[field]} — fragments come from different releases.`,
      );
    }
  }
}

// Every artifact the manifests will point at must actually be in the upload set,
// at the size the fragment recorded.
for (const fragment of fragments) {
  const names = platformArtifactNames(fragment.platformKey, fragment.version);
  for (const file of new Set([names.installer, names.updater, names.updaterSigFile])) {
    if (!existsSync(resolve(dir, file))) fail(`${fragment.platformKey}: ${file} is not in ${dir}`);
  }
  const installerSize = statSync(resolve(dir, names.installer)).size;
  if (installerSize !== fragment.installerSizeBytes) {
    fail(
      `${fragment.platformKey}: ${names.installer} is ${installerSize} bytes, fragment recorded ${fragment.installerSizeBytes} — corrupted transfer?`,
    );
  }
}

// ── Assemble and emit ──

const { latest, downloads } = buildAppReleaseManifests({
  version: head.version,
  nativeApiVersion: head.nativeApiVersion,
  channel,
  artifactBaseUrl,
  releasedAt: head.releasedAt,
  notes: head.notes,
  platforms: fragments.map((fragment) => ({
    platformKey: fragment.platformKey,
    updaterSig: fragment.updaterSig,
    installerSizeBytes: fragment.installerSizeBytes,
  })),
});

writeFileSync(resolve(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
writeFileSync(resolve(dir, 'downloads.json'), `${JSON.stringify(downloads, null, 2)}\n`);

console.log(
  `\n✅ shell release ${head.version} (${channel}, native API ${head.nativeApiVersion}): ${fragments
    .map((fragment) => fragment.platformKey)
    .join(' + ')}`,
);
console.log(`   ${dir}`);
console.log(`   artifacts are expected at ${artifactBaseUrl}/
`);

// ── helpers ──

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
