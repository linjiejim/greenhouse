/**
 * Fork startup hook (API) — the ONE place a downstream fork wires the runtime
 * `register*()` extension seams that must be CALLED at startup (as opposed to the
 * `*.extensions.ts` arrays, which are auto-imported by their central file).
 *
 * Upstream is a no-op. `index.ts` calls `bootstrapForkExtensions()` at the start
 * of `main()` — after `.env` is loaded, before the server starts — so a fork
 * registers its LLM providers, tool summarizers, feature flags, email connectors
 * and storage driver here WITHOUT editing `index.ts`.
 *
 * Fork example (in the fork's copy of this file):
 *   import { registerProviderFactory } from '@greenhouse/agent-core';
 *   import { registerFeatureFlags } from '@greenhouse/types';
 *   import { registerEmailConnector } from './email/extensions.js';
 *   import { registerStorageDriver } from './storage/extensions.js';
 *   export function bootstrapForkExtensions(): void {
 *     registerProviderFactory('deepseek', async ({ model, apiKey, baseUrl }) => { ... });
 *     registerFeatureFlags([{ key: 'crm', label: 'CRM', description: '...' }]);
 *     registerEmailConnector('gmail', async (db, account) => { ... });
 *     registerStorageDriver(cosDriver);
 *   }
 */

export function bootstrapForkExtensions(): void {
  // Empty upstream — a downstream fork populates its own copy of this file.
}
