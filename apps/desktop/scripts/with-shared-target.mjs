#!/usr/bin/env node
// Wrapper for every cargo / tauri invocation of the desktop shell.
//
// 1. Locally, the Rust target dir is shared across worktrees (`~/.cargo-target/
//    greenhouse-desktop`) so the machine keeps ONE incremental cache instead of a
//    4–6 GB copy per tree. CI is not redirected (release workflows collect the
//    artifacts from `apps/desktop/src-tauri/target/**`), and an explicit
//    CARGO_TARGET_DIR is always respected.
// 2. `tauri dev|build` get the deployment overlay from `tauri-config.mjs` appended
//    as `--config`, so a fork or a release pipeline configures the shell with
//    environment variables instead of editing `tauri.conf.json`.
// 3. Local macOS `tauri build`s are ad-hoc signed as a whole bundle, and updater
//    artifacts are skipped when there is no minisign key — see prepareDesktopCommand.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTauriConfigOverlay, committedCsp } from './tauri-config.mjs';

// Where build output lands must be answered by ONE function, shared with the
// script that collects the artifacts — otherwise make-app-release.mjs looks for a
// dmg in an empty in-tree directory. `undefined` = do not redirect (cargo's own
// in-tree target/).
export function sharedCargoTargetDir(env = process.env) {
  if (env.CARGO_TARGET_DIR) return resolve(env.CARGO_TARGET_DIR);
  if (env.CI) return undefined;
  return join(homedir(), '.cargo-target', 'greenhouse-desktop');
}

function tauriSubcommand(command, args) {
  const executable = command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.cmd$/i, '');
  return executable === 'tauri' ? args[0] : undefined;
}

function insertBeforeRunnerArgs(args, values) {
  const separator = args.indexOf('--');
  args.splice(separator === -1 ? args.length : separator, 0, ...values);
}

/**
 * Give local packages a real bundle signature instead of leaving only Cargo's
 * linker signature on the Mach-O executable. macOS TCC evaluates the running
 * app's code requirement for Accessibility and Screen Recording; an unsealed
 * bundle can therefore show as enabled in System Settings while
 * AXIsProcessTrusted still returns false.
 *
 * CI keeps its signing identity and updater key untouched. Local builds use a
 * full-bundle ad-hoc signature and skip updater artifacts when their minisign
 * private key is not available.
 *
 * `overlay` is the deployment overlay (already computed, so this stays pure); it
 * is appended to `tauri dev` and `tauri build` alike, in CI too — that is the
 * whole point of it.
 */
export function prepareDesktopCommand(command, args, env = process.env, platform = process.platform, overlay = null) {
  const nextArgs = [...args];
  const nextEnv = { ...env };
  const subcommand = tauriSubcommand(command, nextArgs);

  if (overlay && (subcommand === 'dev' || subcommand === 'build')) {
    insertBeforeRunnerArgs(nextArgs, ['--config', JSON.stringify(overlay)]);
  }

  if (subcommand !== 'build' || nextEnv.CI) {
    return { args: nextArgs, env: nextEnv };
  }

  if (
    platform === 'darwin' &&
    !nextArgs.includes('--no-sign') &&
    !nextEnv.APPLE_SIGNING_IDENTITY &&
    !nextEnv.APPLE_CERTIFICATE
  ) {
    nextEnv.APPLE_SIGNING_IDENTITY = '-';
  }

  if (!nextEnv.TAURI_SIGNING_PRIVATE_KEY) {
    insertBeforeRunnerArgs(nextArgs, ['--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } })]);
  }

  return { args: nextArgs, env: nextEnv };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: with-shared-target.mjs <command> [args...]');
    process.exit(2);
  }

  const overlay = buildTauriConfigOverlay(process.env, await committedCsp());
  const prepared = prepareDesktopCommand(cmd, args, process.env, process.platform, overlay);
  const env = prepared.env;
  const targetDir = sharedCargoTargetDir(env);
  if (targetDir) env.CARGO_TARGET_DIR = targetDir;

  const child = spawn(cmd, prepared.args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
