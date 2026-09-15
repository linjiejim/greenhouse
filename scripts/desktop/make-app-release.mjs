#!/usr/bin/env node
/**
 * Collect THIS platform's built shell artifacts into a release fragment.
 *
 * Runs after `pnpm desktop:build` on whichever OS built the shell (CI:
 * publish-desktop-updates.yml, macOS and Windows runners alike). Renames the
 * bundler's outputs to the unified `Greenhouse-<version>-<arch>` stem and writes a
 * `fragment-<platformKey>.json` describing them. It does NOT write the manifests:
 * that is `merge-app-release.mjs`'s job, once every platform's fragment is in one
 * place — a single assembly path whether CI or a laptop is publishing.
 *
 *   pnpm desktop:build && node scripts/desktop/make-app-release.mjs
 *
 * Emits into apps/desktop/release/app/:
 *   macOS:    Greenhouse-<v>-aarch64.dmg / .app.tar.gz / .app.tar.gz.sig
 *   Windows:  Greenhouse-<v>-x86_64-setup.exe / -setup.exe.sig
 *   both:     fragment-<platformKey>.json
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformArtifactNames } from './app-release-manifests.mjs';
import { sharedCargoTargetDir } from '../../apps/desktop/scripts/with-shared-target.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Same resolution the build wrapper uses, or cargo's in-tree default (CI).
const targetDir = sharedCargoTargetDir() ?? resolve(repoRoot, 'apps/desktop/src-tauri/target');
const bundleDir = resolve(targetDir, 'release/bundle');
const outDir = resolve(repoRoot, 'apps/desktop/release/app');

const version = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')).version;
const nativeApiVersion = JSON.parse(
  readFileSync(resolve(repoRoot, 'apps/desktop/package.json'), 'utf-8'),
).nativeApiVersion;

const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : null;
if (!os) fail(`shell releases are packaged on macOS or Windows, not ${process.platform}.`);
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const platformKey = `${os}-${arch}`;
const names = platformArtifactNames(platformKey, version);

// ── Locate the bundler outputs, failing loudly on anything missing ──

let installerSrc;
let updaterSrc;
let updaterSigSrc;

if (os === 'darwin') {
  const macosDir = resolve(bundleDir, 'macos');
  updaterSrc = resolve(macosDir, 'Greenhouse.app.tar.gz');
  updaterSigSrc = `${updaterSrc}.sig`;
  if (!existsSync(updaterSrc) || !existsSync(updaterSigSrc)) {
    fail(
      `updater artifacts missing under ${macosDir} — run \`pnpm desktop:build\` with TAURI_SIGNING_PRIVATE_KEY set (createUpdaterArtifacts needs the key).`,
    );
  }
  const dmgDir = resolve(bundleDir, 'dmg');
  const dmgName = existsSync(dmgDir) ? readdirSync(dmgDir).find((name) => name.endsWith('.dmg')) : undefined;
  if (!dmgName) fail(`no .dmg under ${dmgDir} — the dmg bundling step failed.`);
  installerSrc = resolve(dmgDir, dmgName);
} else {
  // The signed NSIS installer is both the browser download and the updater payload.
  const nsisDir = resolve(bundleDir, 'nsis');
  const exeName = existsSync(nsisDir) ? readdirSync(nsisDir).find((name) => name.endsWith('-setup.exe')) : undefined;
  if (!exeName) fail(`no -setup.exe under ${nsisDir} — the nsis bundling step failed.`);
  installerSrc = resolve(nsisDir, exeName);
  updaterSrc = installerSrc;
  updaterSigSrc = `${installerSrc}.sig`;
  if (!existsSync(updaterSigSrc)) {
    fail(
      `no signature beside ${exeName} — run \`pnpm desktop:build\` with TAURI_SIGNING_PRIVATE_KEY set (createUpdaterArtifacts needs the key).`,
    );
  }
}

// Release notes are optional here (they gate the web-bundle line, not this one):
// a shell release cut outside `/ship` still needs a valid feed. Both CI builders
// see the same committed release-notes.json (desktop:build runs web:build), so
// fragments agree on these fields whenever the file exists.
let releasedAt = new Date().toISOString();
let notes = `Greenhouse ${version}`;
try {
  const rn = JSON.parse(readFileSync(resolve(repoRoot, 'public/release-notes.json'), 'utf-8'));
  if (typeof rn.releasedAt === 'string' && !Number.isNaN(Date.parse(rn.releasedAt))) releasedAt = rn.releasedAt;
  if (typeof rn.title === 'string' && rn.title.trim()) notes = `${rn.title.trim()} — Greenhouse ${version}`;
} catch {
  // fall back to the defaults above
}

// ── Emit ──

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

copyFileSync(installerSrc, resolve(outDir, names.installer));
if (updaterSrc !== installerSrc) copyFileSync(updaterSrc, resolve(outDir, names.updater));
copyFileSync(updaterSigSrc, resolve(outDir, names.updaterSigFile));

const fragment = {
  schemaVersion: 1,
  platformKey,
  version,
  nativeApiVersion,
  releasedAt,
  notes,
  updaterSig: readFileSync(updaterSigSrc, 'utf-8'),
  installerSizeBytes: statSync(installerSrc).size,
};
writeFileSync(resolve(outDir, `fragment-${platformKey}.json`), `${JSON.stringify(fragment, null, 2)}\n`);

const installerMb = (fragment.installerSizeBytes / 1_048_576).toFixed(1);
console.log(
  `\n✅ shell fragment ${version} (${platformKey}, native API ${nativeApiVersion}, installer ${installerMb} MB)`,
);
console.log(`   ${outDir}`);
console.log('\nAssemble the manifests once every platform fragment is here:');
console.log('   node scripts/desktop/merge-app-release.mjs --channel <stable|beta>\n');

// ── helpers ──

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
