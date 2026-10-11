// Standalone Expo app (not a pnpm workspace member). It lives nested inside the
// monorepo, so Metro's default hierarchical node_modules lookup can walk UP to
// the repo-root node_modules and pick up a leaked/duplicate copy of a dependency
// (e.g. react-native-worklets), causing native/JS version mismatches.
//
// Fix: keep pnpm's nested resolution working, but make the repo-root
// node_modules invisible to Metro. This isolates the app from the workspace —
// mirroring the install-time `--ignore-workspace`.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const rootModules = path.resolve(__dirname, '..', '..', 'node_modules');
const escaped = rootModules.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRoot = new RegExp(`^${escaped}[\\\\/].*`);

config.watchFolders = [__dirname];
// Android toolbar icons are XML vector drawables (assets/icons/android, see
// src/ui/toolbar-icon.android.ts) — @expo/ui's Compose Icon loads them as assets.
config.resolver.assetExts = [...config.resolver.assetExts, 'xml'];
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, blockRoot)
  : [blockRoot];

// The contracts vendored verbatim from packages/types (src/shared/tables.ts,
// table-access.ts, table-cards.ts, apps.ts …) keep their NodeNext sibling
// specifiers (`./tables.js`). TypeScript's bundler resolution maps those to the
// .ts file; Metro does not, so a relative `./x.js` from src/shared/ that has no
// .js file resolves as `./x` (Metro then tries the source extensions).
// (Metro's documented chaining: `context.resolveRequest` is the next resolver.)
const sharedDir = path.join(__dirname, 'src', 'shared') + path.sep;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('./') && moduleName.endsWith('.js') && context.originModulePath.startsWith(sharedDir)) {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      return context.resolveRequest(context, moduleName.slice(0, -'.js'.length), platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
