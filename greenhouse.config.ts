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
  plugins: ['./plugins/example', './plugins/memory', './plugins/feedback', './plugins/reports', './plugins/computer'],
  extensions: {
    // Packages above and SDK 1 in-tree registrations are compiled in; this switches them on.
    // 'all' enables every compiled extension. GREENHOUSE_EXTENSIONS overrides at boot.
    enabled: ['knowledge', 'tables', 'skills', 'feedback', 'memory'],
  },
  packs: {
    // Extra skill-pack roots (same layout as skillhub/) and profile directories.
    skills: [],
    profiles: [],
    // seeds: 'data/my-company',   // dataset for `pnpm seed`
  },
  clients: {
    stations: {
      // 'multi': users add and switch Greenhouse servers in the mobile app.
      // 'single': lock a client build to the one station below. The mobile build
      // mirrors this through EXPO_PUBLIC_STATIONS_MODE / EXPO_PUBLIC_API_BASE_URL.
      mode: 'multi',
      defaults: [],
    },
  },
});
