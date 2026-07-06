/**
 * Package the built extension into a versioned, store-ready zip.
 *
 * Runs after `vite build` (see the `package` npm script). Two steps:
 *   1. Stamp dist/manifest.json `version` from APP_VERSION (the release tag),
 *      normalised to Chrome's numeric form. Without APP_VERSION the manifest
 *      keeps whatever public/manifest.json shipped — dev builds stay stable.
 *   2. Zip dist/ → greenhouse-bridge-v<version>.zip (what "Load unpacked" /
 *      the Chrome Web Store submission consume). CI attaches it to the Release.
 *
 * Uses the system `zip` (present on macOS + CI ubuntu) — no npm dependency.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toManifestVersion } from './manifest-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const manifestPath = resolve(dist, 'manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const stamped = toManifestVersion(process.env.APP_VERSION);
if (stamped && stamped !== manifest.version) {
  manifest.version = stamped;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Stamped manifest version → ${stamped}`);
}

const zipPath = resolve(here, `../greenhouse-bridge-v${manifest.version}.zip`);
rmSync(zipPath, { force: true });
// -r recurse, -X drop extra file attributes (deterministic-ish archive).
execFileSync('zip', ['-r', '-X', zipPath, '.'], { cwd: dist, stdio: 'inherit' });
console.log(`Packaged ${zipPath}`);
