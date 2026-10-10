/**
 * Greenhouse home-screen widget. Colors follow the app's native palette
 * (src/theme.ts): iOS system background/text + the Haven accent; brand tints
 * are pre-composited over the widget background (#FFFFFF / #1C1C1E) since
 * colorsets need opaque hexes.
 */

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'GreenhouseWidget',
  displayName: 'Greenhouse',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  entitlements: {
    // Same App Group as the host app (app.json ios.entitlements) — the
    // snapshot handoff (modules/widget-bridge) depends on it.
    'com.apple.security.application-groups': ['group.app.greenhouse.mobile'],
  },
  // NOTE: the key shape is `{ light, dark }` — the plugin README's
  // `{ color, darkColor }` is stale and silently yields EMPTY colorsets
  // (every named Color renders transparent; texts/pills vanish).
  colors: {
    // System-recognized: widget editing tint + default background.
    $accent: { light: '#235D4D', dark: '#B1D2BF' },
    $widgetBackground: { light: '#FFFFFF', dark: '#1C1C1E' },
    // Brand fills (theme.ts accent / onAccent / accentFill), pre-composited
    // over the widget background since colorsets need opaque hexes. Text and
    // status colors are SwiftUI semantic styles (.primary / .secondary /
    // .green / .red) in index.swift, so they follow the system exactly.
    OnAccent: { light: '#FFFFFF', dark: '#123427' },
    AccentTint: { light: '#E5ECEA', dark: '#343938' },
    AccentBorder: { light: '#BDCECA', dark: '#49534E' },
    // The Dynamic Island is always black: the Live Activity's accent there is the dark one
    // in both schemes (BotTaskLiveActivity.swift).
    IslandAccent: { light: '#B1D2BF', dark: '#B1D2BF' },
  },
  // Sprouty's plant avatar, rendered by apps/mobile/scripts/render-widget-art.mjs from the
  // vendored static builder (light + dark palettes; mono = lock-screen knockout silhouette).
  images: {
    sprouty: './sprouty-idle.png',
    sproutySleep: './sprouty-sleep.png',
    sproutyDark: './sprouty-idle-dark.png',
    sproutySleepDark: './sprouty-sleep-dark.png',
    sproutyMono: './sprouty-mono.png',
  },
};
