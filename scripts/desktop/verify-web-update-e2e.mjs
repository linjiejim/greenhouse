#!/usr/bin/env node
/**
 * Exercise the signed Web Bundle updater through the real Tauri application.
 *
 * The check compiles a debug shell whose embedded bundle is labelled one version
 * behind this checkout, points it at an isolated app-data directory and a beta
 * update source:
 *
 *   launch 1: baseline mounts, then automatically downloads/stages beta current
 *   launch 2: staged current mounts and clears its boot watchdog
 *   launch 3: current mounts again, proving it was not falsely rolled back
 *
 *   node scripts/desktop/verify-web-update-e2e.mjs           the published v2 beta
 *   node scripts/desktop/verify-web-update-e2e.mjs --local   this checkout, served locally
 *
 * The published check reads GREENHOUSE_DESKTOP_UPDATE_BASE (default the v2 path) and
 * needs GREENHOUSE_WEB_BUNDLE_PUBKEY (or apps/desktop/.keys) to match the CI key.
 * --local packages public/ (run `pnpm web:build` first; it replaces
 * apps/desktop/release/web), signs it with a throwaway key baked into this shell
 * only, and serves it from 127.0.0.1 as <base>/beta/web/. Nothing is published.
 *
 * It never touches the installed app's data or the stable update channel.
 */

import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedCargoTargetDir } from '../../apps/desktop/scripts/with-shared-target.mjs';
import { resolveWebBundleVersion } from './web-bundle-version.mjs';

if (process.platform !== 'darwin') {
  fail('this lifecycle check currently requires macOS because it launches the desktop shell');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cargoManifest = resolve(repoRoot, 'apps/desktop/src-tauri/Cargo.toml');
const targetDir = sharedCargoTargetDir() ?? resolve(repoRoot, 'apps/desktop/src-tauri/target');
const binary = resolve(targetDir, 'debug/greenhouse-desktop');
const qaRoot = mkdtempSync(resolve(tmpdir(), 'greenhouse-web-update-e2e-'));
const pointerPath = resolve(qaRoot, 'web-bundles/current.json');
// The bundle the beta channel must be serving: this checkout's own version.
const expectedVersion = resolveWebBundleVersion(process.env, repoRoot);
if (BigInt(expectedVersion) < 2n) {
  fail(`the web bundle version must be >= 2 to have a baseline one behind it, got ${expectedVersion}`);
}
const baselineVersion = String(BigInt(expectedVersion) - 1n);
const local = process.argv.includes('--local');
const qaEnv = {
  ...process.env,
  GREENHOUSE_QA_APP_DATA_DIR: qaRoot,
  GREENHOUSE_QA_BASELINE_WEB_BUNDLE_VERSION: baselineVersion,
  GREENHOUSE_UPDATE_CHANNEL: 'beta',
  GREENHOUSE_DESKTOP_UPDATE_BASE:
    process.env.GREENHOUSE_DESKTOP_UPDATE_BASE ?? 'https://greenhouse.linjiejim.com/updates/desktop/v2',
};

let activeChild;
let completed = false;
let source;

try {
  console.log(`QA data: ${qaRoot}`);
  if (local) {
    source = await serveLocalBundle();
    qaEnv.GREENHOUSE_DESKTOP_UPDATE_BASE = source.updateBase;
    qaEnv.GREENHOUSE_WEB_BUNDLE_PUBKEY = source.publicKey;
  }
  console.log(`Update source: ${qaEnv.GREENHOUSE_DESKTOP_UPDATE_BASE}/beta`);
  console.log(`Building isolated baseline-v${baselineVersion} shell…`);
  await runCommand('cargo', ['build', '--features', 'tauri/custom-protocol', '--manifest-path', cargoManifest], {
    ...qaEnv,
    CARGO_TARGET_DIR: targetDir,
  });

  console.log(`Launch 1/3: waiting for automatic beta v${expectedVersion} staging…`);
  activeChild = launchShell();
  await waitFor(
    () => {
      const pointer = readPointer();
      return pointer?.webBundleVersion === expectedVersion && pointer.bootPending === false;
    },
    55_000,
    `the app did not stage beta Web Bundle v${expectedVersion}`,
  );
  const stagedAt = statSync(pointerPath).mtimeMs;
  await stopShell(activeChild);
  activeChild = undefined;

  console.log(`Launch 2/3: booting staged v${expectedVersion} and waiting for mount confirmation…`);
  activeChild = launchShell();
  await waitForPointerRewrite(stagedAt);
  const confirmedAt = statSync(pointerPath).mtimeMs;
  await stopShell(activeChild);
  activeChild = undefined;

  console.log(`Launch 3/3: confirming successful v${expectedVersion} is retained…`);
  activeChild = launchShell();
  await waitForPointerRewrite(confirmedAt);
  const finalPointer = readPointer();
  if (finalPointer?.webBundleVersion !== expectedVersion || finalPointer.bootPending !== false) {
    fail(`unexpected final pointer: ${JSON.stringify(finalPointer)}`);
  }
  await stopShell(activeChild);
  activeChild = undefined;

  if (source && source.served.size === 0) fail('the shell never downloaded from the local update source');
  completed = true;
  console.log(
    `✅ baseline v${baselineVersion} → beta v${expectedVersion} staging → ` +
      `v${expectedVersion} boot confirmation → retained restart`,
  );
} finally {
  if (activeChild) await stopShell(activeChild);
  if (source) await source.close();
  if (completed) {
    rmSync(qaRoot, { recursive: true, force: true });
  } else {
    console.error(`QA data retained for diagnosis: ${qaRoot}`);
  }
}

/**
 * Packages this checkout's public/ as beta, signed with a throwaway ed25519 key, and
 * serves it the way the project site does: <update base>/beta/web/manifest.json with
 * the tarball beside it.
 */
async function serveLocalBundle() {
  if (!existsSync(resolve(repoRoot, 'public/index.html'))) fail('public/index.html is missing: run `pnpm web:build`');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  await runCommand('node', ['scripts/desktop/make-web-bundle.mjs', '--channel', 'beta'], {
    ...process.env,
    WEB_BUNDLE_SIGN_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GREENHOUSE_WEB_BUNDLE_VERSION: expectedVersion,
  });

  const site = mkdtempSync(resolve(tmpdir(), 'greenhouse-web-update-site-'));
  const webDir = resolve(site, 'updates/desktop/v2/beta/web');
  mkdirSync(webDir, { recursive: true });
  const built = resolve(repoRoot, 'apps/desktop/release/web');
  for (const name of ['manifest.json', `web-bundle-${expectedVersion}.tar.gz`]) {
    copyFileSync(resolve(built, name), resolve(webDir, name));
  }

  const served = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = resolve(site, `.${path}`);
    if (!file.startsWith(`${site}/`) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    served.add(basename(file));
    response.writeHead(200).end(readFileSync(file));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  return {
    updateBase: `http://127.0.0.1:${port}/updates/desktop/v2`,
    publicKey: raw.toString('base64'),
    served,
    close: async () => {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      rmSync(site, { recursive: true, force: true });
    },
  };
}

function launchShell() {
  const child = spawn(binary, [], {
    cwd: repoRoot,
    env: qaEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForPointerRewrite(previousMtime) {
  await waitFor(
    () => {
      const pointer = readPointer();
      if (pointer?.webBundleVersion !== expectedVersion || pointer.bootPending !== false) {
        return false;
      }
      return statSync(pointerPath).mtimeMs > previousMtime;
    },
    20_000,
    `staged v${expectedVersion} did not complete its boot watchdog handshake`,
  );
}

function readPointer() {
  try {
    return JSON.parse(readFileSync(pointerPath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (activeChild?.exitCode !== null) {
      fail(`desktop shell exited early with code ${activeChild.exitCode}`);
    }
    if (predicate()) return;
    await delay(50);
  }
  fail(message);
}

async function runCommand(command, args, env) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `code ${code}`})`));
      }
    });
  });
}

async function stopShell(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolvePromise) => child.once('exit', () => resolvePromise()));
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function fail(message) {
  throw new Error(message);
}
