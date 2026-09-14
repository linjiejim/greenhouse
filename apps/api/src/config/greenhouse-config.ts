/**
 * Loads `greenhouse.config.ts` once at boot and exposes the validated result.
 *
 * The file is imported dynamically so a deployment can point `GREENHOUSE_CONFIG` at
 * another path (or ship none at all — every section has defaults). Top-level await
 * makes the config available to every module that imports this one, including the
 * registries that decide which extensions to activate.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GreenhouseConfig } from '@greenhouse/types/config';
import { isExtensionEnabled, parseExtensionsEnv } from '@greenhouse/types/config';
import { parseGreenhouseConfig } from '@greenhouse/types/config-schema';
import { REPO_ROOT } from '../paths.js';

export const GREENHOUSE_CONFIG_FILE = process.env.GREENHOUSE_CONFIG
  ? resolve(REPO_ROOT, process.env.GREENHOUSE_CONFIG)
  : resolve(REPO_ROOT, 'greenhouse.config.ts');

/** Env overrides that let one image be trimmed per deployment without editing the file. */
export function applyConfigEnv(config: GreenhouseConfig, env: NodeJS.ProcessEnv = process.env): GreenhouseConfig {
  const extensions = parseExtensionsEnv(env.GREENHOUSE_EXTENSIONS);
  if (extensions === undefined) return config;
  return { ...config, extensions: { ...config.extensions, enabled: extensions } };
}

async function load(): Promise<GreenhouseConfig> {
  let input: unknown = {};
  if (existsSync(GREENHOUSE_CONFIG_FILE)) {
    const mod = (await import(pathToFileURL(GREENHOUSE_CONFIG_FILE).href)) as { default?: unknown; config?: unknown };
    input = mod.default ?? mod.config ?? {};
  }
  return applyConfigEnv(parseGreenhouseConfig(input));
}

/** The deployment configuration, validated and with env overrides applied. */
export const GREENHOUSE_CONFIG: GreenhouseConfig = await load();

/** Whether an extension id is switched on for this deployment. */
export function extensionEnabled(id: string): boolean {
  return isExtensionEnabled(GREENHOUSE_CONFIG.extensions.enabled, id);
}

/** Resolve a pack path from the config (absolute, or relative to the repository root). */
export function resolvePackPath(path: string): string {
  return resolve(REPO_ROOT, path);
}
