/**
 * Deployment configuration — see packages/types/src/config.ts for the full shape and
 * EXTENDING.md for how extensions and content packs plug in.
 *
 * Only *structure* lives here (what is compiled in and switched on, where content
 * packs are, how clients treat stations). Secrets stay in `.env`; live product knobs
 * (LLM credentials, product name, branding) stay in Administration → Runtime Config.
 *
 * A fork keeps its own version of this file; upstream ships the open-source defaults.
 */
import { defineConfig } from '@greenhouse/types/config';

export default defineConfig({
  extensions: {
    // Extensions listed in apps/api/src/extensions/index.ts and
    // apps/web/src/extensions/index.ts are compiled in; this list switches them on.
    // 'all' enables every compiled extension. GREENHOUSE_EXTENSIONS overrides at boot.
    enabled: [],
  },
  packs: {
    // Extra skill-pack roots (same layout as skillhub/) and profile directories.
    skills: [],
    profiles: [],
    // seeds: 'data/my-company',   // dataset for `pnpm seed`
  },
  clients: {
    stations: {
      // 'multi': users add and switch Greenhouse servers in the browser extension and
      // the mobile app. 'single': lock a client build to the one station below.
      mode: 'multi',
      defaults: [],
    },
  },
});
