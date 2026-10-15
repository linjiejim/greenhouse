/** Deployment structure. See EXTENDING.md for the v2 extension surfaces. Secrets stay in .env. */
import { defineConfig } from '@greenhouse/types/config';

export default defineConfig({
  extensions: {
    // Register each implementation in the API and Web extensions/index.ts first.
    // GREENHOUSE_EXTENSIONS=example (or all, or empty) overrides this list at API boot.
    enabled: [],
  },
  clients: { stations: { mode: 'multi', defaults: [] } },
});
