#!/usr/bin/env node
/**
 * Exercise the signed Web Bundle updater through the real Tauri application.
 *
 * The check compiles a debug shell whose embedded bundle is labelled one version
 * behind package.json, points it at an isolated app-data directory, and uses the
 * public beta update source:
 *
 *   launch 1: baseline mounts, then automatically downloads/stages beta current
 *   launch 2: staged current mounts and clears its boot watchdog
 *   launch 3: current mounts again, proving it was not falsely rolled back
 *
 * It never touches the installed app's data or the stable update channel.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
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
const qaEnv = {
  ...process.env,
  GREENHOUSE_QA_APP_DATA_DIR: qaRoot,
  GREENHOUSE_QA_BASELINE_WEB_BUNDLE_VERSION: baselineVersion,
  GREENHOUSE_UPDATE_CHANNEL: 'beta',
};

let activeChild;
let completed = false;

try {
  console.log(`QA data: ${qaRoot}`);
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

  completed = true;
  console.log(
    `✅ baseline v${baselineVersion} → beta v${expectedVersion} staging → ` +
      `v${expectedVersion} boot confirmation → retained restart`,
  );
} finally {
  if (activeChild) await stopShell(activeChild);
  if (completed) {
    rmSync(qaRoot, { recursive: true, force: true });
  } else {
    console.error(`QA data retained for diagnosis: ${qaRoot}`);
  }
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
