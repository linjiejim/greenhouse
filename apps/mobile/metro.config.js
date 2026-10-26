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
const fs = require('fs');

const config = getDefaultConfig(__dirname);

const rootModules = path.resolve(__dirname, '..', '..', 'node_modules');
const escaped = rootModules.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRoot = new RegExp(`^${escaped}[\\\\/].*`);

config.watchFolders = [__dirname];
// Android toolbar icons are XML vector drawables (assets/icons/android, see
// src/ui/toolbar-icon.android.ts) — @expo/ui's Compose Icon loads them as assets. Mermaid ships
// as assets/web/mermaid.min.txt, read once and injected into the diagram WebView (no CDN).
config.resolver.assetExts = [...config.resolver.assetExts, 'xml', 'txt'];
config.resolver.blockList = config.resolver.blockList ? [].concat(config.resolver.blockList, blockRoot) : [blockRoot];

// Router's context deliberately enumerates every platform route. On web redirect
// those context dependencies to the web view (or the shared route), so native
// form implementations are absent from the dependency graph, not merely idle.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && /\.(?:ios|android|native)(?:\.[jt]sx?)?$/.test(moduleName)) {
    const absolute = path.isAbsolute(moduleName)
      ? moduleName
      : path.resolve(path.dirname(context.originModulePath), moduleName);
    if (absolute.startsWith(path.join(__dirname, 'app') + path.sep)) {
      const web = absolute.replace(/\.(?:ios|android|native)(\.[jt]sx?)?$/, (_, ext) => '.web' + (ext || ''));
      const shared = absolute.replace(/\.(?:ios|android|native)(\.[jt]sx?)?$/, (_, ext) => ext || '');
      const candidates = [web, web + '.tsx', web + '.ts', shared, shared + '.tsx', shared + '.ts'];
      moduleName = candidates.find((candidate) => fs.existsSync(candidate)) || shared;
    }
  }
  if (platform !== 'web' && /\.web(?:\.[jt]sx?)?$/.test(moduleName)) {
    const absolute = path.isAbsolute(moduleName)
      ? moduleName
      : path.resolve(path.dirname(context.originModulePath), moduleName);
    if (absolute.startsWith(path.join(__dirname, 'app') + path.sep)) {
      moduleName = absolute.replace(/\.web(\.[jt]sx?)?$/, (_, ext) => ext || '');
    }
  }
  return originalResolveRequest
    ? originalResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
