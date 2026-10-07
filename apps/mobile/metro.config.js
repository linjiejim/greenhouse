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

module.exports = config;
