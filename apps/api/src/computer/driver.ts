/**
 * What the cloud-computer lifecycle (service.ts) needs from a hosted sandbox,
 * and the one implementation of it: E2B (e2b/driver.ts).
 *
 * This is a seam for tests, not a multi-provider layer: production always gets
 * the E2B driver, built from the workspace's E2B settings; tests install a
 * fake with `setComputerDriverForTests` so no test ever reaches E2B and the
 * "never creates a sandbox while disabled" rule can be asserted on `create`.
 */

import type { ExecResult } from './e2b/envd.js';
import { createE2bDriver } from './e2b/driver.js';
import { e2bConfigFromEnv } from './config.js';
export { COMPUTER_HOME, COMPUTER_USER } from './config.js';

export type { ExecResult };

export interface ComputerDriver {
  /** A new sandbox the provider kills after `timeoutSeconds` unless renewed. */
  create(input: { computerId: string; userId: string; timeoutSeconds: number }): Promise<{ sandboxId: string }>;
  /** Runs `command` in bash as the computer's user; the deadline is enforced inside the computer too. */
  exec(
    sandboxId: string,
    input: { command: string; cwd?: string; timeoutMs: number; maxOutputBytes: number },
  ): Promise<ExecResult>;
  readFile(sandboxId: string, input: { path: string; maxBytes: number }): Promise<Buffer>;
  writeFile(sandboxId: string, input: { path: string; bytes: Buffer }): Promise<void>;
  /** Pushes the provider's kill deadline to `timeoutSeconds` from now; false when the sandbox is gone. */
  renew(sandboxId: string, timeoutSeconds: number): Promise<boolean>;
  /** Kills the sandbox; one already gone is not an error. Throws when the provider did not confirm. */
  kill(sandboxId: string): Promise<void>;
}

let testDriver: ComputerDriver | null = null;

/** The driver for the workspace's current E2B settings. */
export function getComputerDriver(): ComputerDriver {
  if (testDriver) return testDriver;
  return createE2bDriver(e2bConfigFromEnv());
}

/** Test seam: every lifecycle call goes to `driver` until reset with null. */
export function setComputerDriverForTests(driver: ComputerDriver | null): void {
  testDriver = driver;
}
