/**
 * Fork startup hook (web) — the ONE place a downstream fork wires the runtime
 * web `register*()` seams that must run before render (as opposed to the
 * `*.extensions.*` arrays auto-imported by the app shell).
 *
 * Upstream is a no-op side-effect module. `app.tsx` imports it at the top so a
 * fork registers its Global-Agent URL context resolvers and locale messages here
 * WITHOUT editing app.tsx.
 *
 * Fork example (in the fork's copy of this file):
 *   import { registerUrlContextResolver } from './lib/context-resolvers';
 *   import { registerLocaleMessages } from './lib/i18n';
 *   registerUrlContextResolver('crm', (subPath) => ({ type: 'crm', module: subPath || undefined }));
 *   registerLocaleMessages('zh', { crm: { title: 'CRM' } });
 */

export {};
