/**
 * Cloud computer settings. All of them are workspace settings with an env
 * fallback (`computer.*` in @greenhouse/types/workspace-settings, overlaid onto
 * process.env by settings/workspace-config.ts), so an admin changes them
 * without a restart and they are read here at call time.
 *
 *   COMPUTER_ENABLED      env fallback of the boolean switch `computer.enabled` (read through
 *                         getWorkspaceFlag like every boolean setting — see computer/service.ts)
 *   E2B_API_KEY           the provider key; without it nothing can start
 *   E2B_DOMAIN            default e2b.app (another E2B-protocol host may differ)
 *   E2B_TEMPLATE          default `base`, E2B's stock template
 *   COMPUTER_MAX_RUNNING  computers running at once across the workspace, default 5
 */

export const E2B_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const E2B_TEMPLATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/;

/** The computer's user and its home in a stock E2B template. */
export const COMPUTER_USER = 'user';
export const COMPUTER_HOME = '/home/user';

/** A computer nobody used for this long is stopped (and the provider kills it a little later on its own). */
export const COMPUTER_IDLE_MINUTES = 15;
/** Per-minute billing reserves this many minutes at a time. */
export const COMPUTER_BLOCK_MINUTES = 15;
/** The longest one command may run. */
export const COMPUTER_EXEC_MAX_SECONDS = 600;
export const DEFAULT_COMPUTER_MAX_RUNNING = 5;

export function isComputerConfigured(): boolean {
  return Boolean(process.env.E2B_API_KEY?.trim());
}

export function computerMaxRunning(): number {
  const parsed = Number(process.env.COMPUTER_MAX_RUNNING?.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : DEFAULT_COMPUTER_MAX_RUNNING;
}

export interface E2bConfig {
  apiKey: string;
  domain: string;
  template: string;
}

export function e2bConfigFromEnv(): E2bConfig {
  const domain = (process.env.E2B_DOMAIN?.trim() || 'e2b.app').toLowerCase();
  const template = process.env.E2B_TEMPLATE?.trim() || 'base';
  if (!E2B_DOMAIN_PATTERN.test(domain)) throw new Error(`E2B_DOMAIN "${domain.slice(0, 80)}" is not a domain name`);
  if (!E2B_TEMPLATE_PATTERN.test(template))
    throw new Error(`E2B_TEMPLATE "${template.slice(0, 80)}" is not a template name`);
  return { apiKey: process.env.E2B_API_KEY?.trim() ?? '', domain, template };
}
