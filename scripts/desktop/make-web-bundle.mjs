#!/usr/bin/env node
/**
 * Package the built web app as a signed hot-update bundle.
 *
 * The bundle version is the checkout's commit count (see web-bundle-version.mjs),
 * the release notes are generated into public/ first (release-notes.mjs) so they
 * ship inside the signed tarball, and installed apps pick the bundle up on their
 * next check and apply it on next launch.
 *
 *   pnpm web:build && node scripts/desktop/make-web-bundle.mjs
 *   node scripts/desktop/make-web-bundle.mjs --channel beta
 *   node scripts/desktop/make-web-bundle.mjs --artifact-base https://github.com/o/r/releases/download/v1.2.0
 *
 * Emits into apps/desktop/release/web/:
 *   web-bundle-<N>.tar.gz   the Vite output from public/
 *   manifest.json           version, digest, signature; `url` is the tarball's file
 *                           name (served beside the manifest) or, with
 *                           --artifact-base, the absolute URL it will live at
 *
 * The signature covers the sha256 *hex string*, matching `verify_bundle` in
 * apps/desktop/src-tauri/src/updater/web_bundle.rs.
 */

import { createHash, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReleaseNotes } from './release-notes.mjs';
import { resolveWebBundleVersion } from './web-bundle-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = resolve(repoRoot, 'public');
const desktopPkgPath = resolve(repoRoot, 'apps/desktop/package.json');
const rootPkgPath = resolve(repoRoot, 'package.json');
const keyPath = process.env.WEB_BUNDLE_SIGN_KEY_PATH ?? resolve(repoRoot, 'apps/desktop/.keys/web-bundle-sign.pem');
const outDir = resolve(repoRoot, 'apps/desktop/release/web');

const channel = argValue('--channel') ?? 'stable';
const artifactBase = argValue('--artifact-base')?.replace(/\/+$/, '');
if (artifactBase !== undefined && !/^https?:\/\/\S+$/.test(artifactBase)) {
  fail(`--artifact-base must be an http(s) URL, got ${JSON.stringify(artifactBase)}`);
}

// ── Preconditions, checked up front so a failure is never half-published ──

if (!existsSync(resolve(publicDir, 'index.html'))) {
  fail('public/index.html is missing — run `pnpm web:build` first.');
}

const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf-8'));
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
const version = resolveWebBundleVersion(process.env, repoRoot);

// The shell refuses bundles that need native code it doesn't have. Default to the
// shell version doing the packaging: a bundle built against this shell is, by
// definition, known to work with it.
const minShellVersion = argValue('--min-shell') ?? desktopPkg.nativeApiVersion;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(minShellVersion ?? '')) {
  fail(`apps/desktop/package.json#nativeApiVersion must be semver, got ${JSON.stringify(minShellVersion)}`);
}

// Generated (or copied from a curated file) right before packaging, so the notes
// inside the tarball always describe this exact bundle.
const releaseNotes = writeReleaseNotes({ repoRoot, publicDir });
if (
  releaseNotes.schemaVersion !== 1 ||
  String(releaseNotes.webBundleVersion) !== version ||
  String(releaseNotes.appVersion) !== String(rootPkg.version) ||
  typeof releaseNotes.title !== 'string' ||
  releaseNotes.title.trim().length === 0 ||
  [...releaseNotes.title].length > 40 ||
  typeof releaseNotes.summary !== 'string' ||
  releaseNotes.summary.trim().length === 0 ||
  [...releaseNotes.summary].length > 100 ||
  !Array.isArray(releaseNotes.changes) ||
  releaseNotes.changes.length < 1 ||
  releaseNotes.changes.length > 6 ||
  releaseNotes.changes.some(
    (change) => typeof change !== 'string' || change.trim().length === 0 || [...change].length > 80,
  )
) {
  fail(`public/release-notes.json does not match app v${rootPkg.version} / web bundle v${version}`);
}

const privateKeyPem = process.env.WEB_BUNDLE_SIGN_KEY ?? readIfExists(keyPath);
if (!privateKeyPem) {
  fail(`No signing key. Set WEB_BUNDLE_SIGN_KEY or create ${keyPath} (see gen-web-bundle-key.mjs).`);
}

// ── Package ──

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const tarballName = `web-bundle-${version}.tar.gz`;
const tarballPath = resolve(outDir, tarballName);

// Source maps are ~70% of the payload and no consumer of a hot update reads them;
// the baseline app still ships them for local debugging.
execFileSync('tar', ['--exclude=*.map', '-czf', tarballPath, '-C', publicDir, '.'], { stdio: 'inherit' });

const tarball = readFileSync(tarballPath);
const sha256 = createHash('sha256').update(tarball).digest('hex');

// ed25519 hashes internally, so it uses the one-shot `sign` with a null algorithm —
// the streaming Sign class requires a digest name and rejects null.
const sig = sign(null, Buffer.from(sha256, 'utf-8'), privateKeyPem).toString('base64');

const manifest = {
  webBundleVersion: version,
  minShellVersion,
  url: artifactBase ? `${artifactBase}/${tarballName}` : tarballName,
  sha256,
  sig,
  releasedAt: releaseNotes.releasedAt,
};
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const sizeMb = (tarball.length / 1_048_576).toFixed(2);
console.log(`\n✅ web bundle v${version} (${sizeMb} MB, min shell ${minShellVersion})`);
console.log(`   ${tarballPath}`);
console.log(`   ${resolve(outDir, 'manifest.json')}`);
console.log(`\nServe manifest.json at <update base>/${channel}/web/manifest.json`);
console.log(
  artifactBase ? `The tarball must be at ${artifactBase}/${tarballName}` : 'The tarball is served beside it.',
);

// ── helpers ──

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
