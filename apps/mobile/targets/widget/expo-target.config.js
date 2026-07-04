/**
 * Greenhouse launcher widget (v1) — static home-screen shortcuts, no data
 * pipeline (no App Group yet). Colors mirror src/theme.ts (Greenhouse Teal
 * light/dark); dark tint/border values are the rgba tokens pre-composited
 * over the dark surface (#1e293b) since colorsets need opaque hexes.
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
    $accent: { light: '#0d9488', dark: '#5eead4' },
    $widgetBackground: { light: '#ffffff', dark: '#1e293b' },
    // App palette (theme.ts light/dark).
    WidgetFg: { light: '#111827', dark: '#f8fafc' },
    WidgetMuted: { light: '#6b7280', dark: '#94a3b8' },
    OnAccent: { light: '#ffffff', dark: '#042f2e' },
    AccentTint: { light: '#f0fdfa', dark: '#1d3a48' },
    AccentBorder: { light: '#99f6e4', dark: '#1c4d56' },
    StatusSuccess: { light: '#059669', dark: '#34d399' },
    StatusDanger: { light: '#dc2626', dark: '#f87171' },
  },
  images: {
    sprouty: './sprouty-idle.png',
    sproutySleep: './sprouty-sleep.png',
  },
};
