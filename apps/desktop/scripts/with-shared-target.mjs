#!/usr/bin/env node
// Wrapper for every cargo / tauri invocation of the desktop shell.
//
// 1. Locally, the Rust target dir is shared across worktrees (`~/.cargo-target/
//    greenhouse-desktop`) so the machine keeps ONE incremental cache instead of a
//    4–6 GB copy per tree. CI is not redirected (release workflows collect the
//    artifacts from `apps/desktop/src-tauri/target/**`), and an explicit
//    CARGO_TARGET_DIR is always respected.
// 2. `tauri dev|build` get a config overlay: the deployment overlay from
//    `tauri-config.mjs` (so a fork or a release pipeline configures the shell with
//    environment variables instead of editing `tauri.conf.json`) plus, for local
//    builds without a minisign key, `createUpdaterArtifacts: false`. The overlay is
//    written to a temp file and passed as `--config <path>` — never inline JSON:
//    on Windows the command goes through cmd.exe, which strips the quotes and hands
//    Tauri `{identifier:…}` ("key must be a string").
// 3. Local macOS `tauri build`s are ad-hoc signed as a whole bundle — see
//    prepareDesktopCommand.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
 * `overlay` is the deployment overlay (already computed, so this stays pure).
 * Returns `{ args, env, config }`: `config` is the merged overlay object to pass
 * to `tauri dev|build` (null when there is nothing to override) — the caller
 * turns it into a `--config <file>` argument.
 */
export function prepareDesktopCommand(command, args, env = process.env, platform = process.platform, overlay = null) {
  const nextArgs = [...args];
  const nextEnv = { ...env };
  const subcommand = tauriSubcommand(command, nextArgs);
  let config = overlay && (subcommand === 'dev' || subcommand === 'build') ? structuredClone(overlay) : null;

  // A CI runner materialises an absent secret as an empty string, and Tauri's
  // bundler reads a set-but-empty APPLE_CERTIFICATE as a certificate to import
  // (`security import` then fails on nothing). Absent is absent.
  for (const key of Object.keys(nextEnv)) {
    if (key.startsWith('APPLE_') && nextEnv[key] === '') delete nextEnv[key];
  }

  if (subcommand !== 'build' || nextEnv.CI) {
    return { args: nextArgs, env: nextEnv, config };
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
    config = { ...(config ?? {}), bundle: { ...(config?.bundle ?? {}), createUpdaterArtifacts: false } };
  }

  return { args: nextArgs, env: nextEnv, config };
}

/** `--config <path>` goes before any `--` runner arguments. */
export function withConfigArg(args, configPath) {
  const next = [...args];
  const separator = next.indexOf('--');
  next.splice(separator === -1 ? next.length : separator, 0, '--config', configPath);
  return next;
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

  let finalArgs = prepared.args;
  if (prepared.config) {
    const configPath = join(mkdtempSync(join(tmpdir(), 'greenhouse-tauri-')), 'tauri.overlay.json');
    writeFileSync(configPath, JSON.stringify(prepared.config));
    finalArgs = withConfigArg(prepared.args, configPath);
  }

  const child = spawn(cmd, finalArgs, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
